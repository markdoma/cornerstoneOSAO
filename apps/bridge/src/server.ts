import { hostHeaderValidation } from '@modelcontextprotocol/fastify';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PrismaClient } from '@prisma/client';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { bridgeVerifier } from '../../../packages/bridge/src/auth.js';
import {
  type BridgeGrant,
  type BridgeConfig,
  modelSchema,
  bindArguments,
  fingerprint,
  serviceError,
} from '../../../packages/bridge/src/contracts.js';
import { callJsonEndpoint, redact } from '../../../packages/bridge/src/http.js';
import { createVault } from './vault.js';
export async function createBridgeServer(options: {
  databaseUrl: string;
  redisUrl: string;
  encryptionKey: string;
  publicKeyPath: string;
  kid?: string;
  allowedOrigin?: string;
  allowedHosts?: string[];
}) {
  const db = new PrismaClient({ datasources: { db: { url: options.databaseUrl } } });
  const vault = createVault(options.redisUrl, options.encryptionKey);
  const verify = await bridgeVerifier(options.publicKeyPath, options.kid);
  const app = Fastify({ logger: false, bodyLimit: 800000, requestTimeout: 130000 });
  app.addHook(
    'onRequest',
    hostHeaderValidation(options.allowedHosts ?? ['localhost', '127.0.0.1', 'bridge']),
  );
  app.setErrorHandler((e: any, _req, reply) =>
    reply
      .status(e.statusCode ?? 400)
      .send({ error: e.statusCode ? e.message : 'Bridge request failed' }),
  );
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await db.$queryRaw`SELECT 1`;
    await vault.ping();
    return { status: 'ok' };
  });
  async function grant(req: any, purpose: string) {
    if (req.headers.origin && req.headers.origin !== options.allowedOrigin)
      throw serviceError(403, 'Bridge origin denied');
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer '))
      throw serviceError(401, 'Bridge authorization required');
    const g = await verify(auth.slice(7));
    if (g.purpose !== purpose) throw serviceError(403, 'Bridge purpose denied');
    return g;
  }
  async function active(g: BridgeGrant) {
    const [dep, mapping, session] = await Promise.all([
      db.deployment.findFirst({
        where: { id: g.deploymentId, orgId: g.orgId, active: true, versionId: g.versionId },
        select: { id: true, authMode: true },
      }),
      db.bridgeTenant.findFirst({
        where: { tenantId: g.tenantId, orgId: g.orgId },
        select: { id: true },
      }),
      db.widgetSession.findFirst({
        where: {
          id: g.sessionId,
          orgId: g.orgId,
          userId: g.userId,
          deploymentId: g.deploymentId,
          versionId: g.versionId,
          tenantId: g.tenantId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true, toolIds: true, credentialHandle: true, employeeId: true },
      }),
    ]);
    if (!dep || dep.authMode !== 'bridge-session' || !mapping || !session)
      throw serviceError(401, 'Bridge session unavailable');
    if (g.toolIds.some((id) => !session.toolIds.includes(id)))
      throw serviceError(403, 'Tool scope mismatch');
    if (g.bindingId && session.credentialHandle !== g.bindingId)
      throw serviceError(403, 'Credential binding mismatch');
    return session;
  }
  async function revisions(g: BridgeGrant) {
    const rows = await db.bridgeRevision.findMany({
      where: { id: { in: g.revisionIds }, orgId: g.orgId },
    });
    if (rows.length !== g.revisionIds.length) throw serviceError(403, 'Bridge revision denied');
    const result = [];
    for (const row of rows) {
      if (
        !(await db.bridge.findFirst({
          where: { id: row.bridgeId, orgId: g.orgId, active: true },
          select: { id: true },
        }))
      )
        throw serviceError(403, 'Bridge disabled');
      if (fingerprint(row.config) !== row.fingerprint)
        throw serviceError(409, 'Bridge revision integrity failed');
      result.push(row);
    }
    return result;
  }
  app.post('/control/credentials', async (req) => {
    const g = await grant(req, 'bind');
    await active(g);
    await revisions(g);
    const body = req.body as any;
    if (
      typeof body?.apiToken !== 'string' ||
      !body.apiToken ||
      body.apiToken.length > 16000 ||
      /[\r\n]/.test(body.apiToken)
    )
      throw serviceError(400, 'Invalid API credential');
    if (
      body.employeeId !== undefined &&
      (typeof body.employeeId !== 'string' || body.employeeId.length > 200)
    )
      throw serviceError(400, 'Invalid employee identity');
    const bindingId = await vault.put(g, body.apiToken, Number(body.expiresAt), body.employeeId);
    return { bindingId };
  });
  app.post('/control/revoke', async (req) => {
    const g = await grant(req, 'revoke');
    if (!g.bindingId) throw serviceError(400, 'Credential binding required');
    try {
      await vault.revoke(g.bindingId, g);
    } catch (e: any) {
      if (e.statusCode !== 401) throw e;
    }
    return { ok: true };
  });
  app.post('/control/health', async (req) => {
    await grant(req, 'health');
    await vault.ping();
    await db.$queryRaw`SELECT 1`;
    return { status: 'ok', protocol: '2026-07-28' };
  });
  app.route({
    method: ['GET', 'DELETE', 'PUT', 'PATCH'],
    url: '/mcp',
    handler: async (_req, reply) => reply.code(405).send({ error: 'Use MCP Streamable HTTP POST' }),
  });
  app.post('/mcp', async (req, reply) => {
    const g = await grant(req, 'mcp');
    const session = await active(g);
    if (!g.bindingId) throw serviceError(401, 'Application credential required');
    const credential = await vault.get(g.bindingId, g);
    const rows = await revisions(g);
    const tools = await db.tool.findMany({
      where: { id: { in: g.toolIds }, orgId: g.orgId, enabled: true },
      select: { id: true, bridgeRevisionId: true, bridgeOperationId: true },
    });
    const controller = new AbortController();
    reply.raw.on('close', () => controller.abort());
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({ name: 'cornerstonelabs-rest-bridge', version: '1.0.0' });
        for (const row of rows) {
          const cfg = row.config as unknown as BridgeConfig;
          if (cfg.tenantId !== g.tenantId) throw serviceError(403, 'Revision tenant mismatch');
          for (const op of cfg.operations.filter(
            (op) =>
              op.enabled &&
              tools.some((t) => t.bridgeRevisionId === row.id && t.bridgeOperationId === op.id),
          )) {
            const schema = modelSchema(op);
            const standard: any = {
              '~standard': {
                version: 1,
                vendor: 'ao-restricted-interpreter',
                jsonSchema: { input: () => schema, output: () => schema },
                validate: (value: unknown) => {
                  try {
                    bindArguments(op, value, {
                      tenantId: g.tenantId,
                      userId: g.userId,
                      employeeId: credential.employeeId,
                    });
                    return { value };
                  } catch (e: any) {
                    return { issues: [{ message: e.message }] };
                  }
                },
              },
            };
            server.registerTool(
              op.definition.name,
              {
                description: op.definition.description,
                inputSchema: standard,
                annotations: {
                  readOnlyHint: op.definition.kind === 'read',
                  destructiveHint: op.definition.kind === 'write',
                  idempotentHint: op.definition.kind === 'read',
                },
                _meta: { revisionId: row.id, fingerprint: row.fingerprint, operationId: op.id },
              },
              async (input: any) => {
                await active(g);
                await revisions(g);
                const current = await vault.get(g.bindingId!, g);
                const digest = fingerprint(input);
                if (
                  g.operationId !== op.id ||
                  !g.executionId ||
                  !g.conversationId ||
                  g.digest !== digest ||
                  g.revisionIds.length !== 1
                )
                  throw serviceError(403, 'Execution authorization mismatch');
                if (op.definition.kind === 'write' && !g.approved)
                  throw serviceError(403, 'Write confirmation required');
                const enabled = await db.tool.findFirst({
                  where: {
                    orgId: g.orgId,
                    bridgeRevisionId: row.id,
                    bridgeOperationId: op.id,
                    id: { in: g.toolIds },
                    enabled: true,
                  },
                  select: { id: true },
                });
                if (!enabled) throw serviceError(403, 'Tool disabled');
                if (op.definition.kind === 'write') {
                  try {
                    await db.bridgeExecution.create({
                      data: {
                        orgId: g.orgId,
                        executionId: g.executionId,
                        revisionId: row.id,
                        operationId: op.id,
                        userId: g.userId,
                        tenantId: g.tenantId,
                        deploymentId: g.deploymentId,
                        digest,
                        status: 'EXECUTING',
                      },
                    });
                  } catch (error: any) {
                    if (error.code === 'P2002')
                      throw serviceError(
                        409,
                        'Write already claimed; inspect application records before retrying',
                      );
                    throw error;
                  }
                }
                try {
                  const { args, headers } = bindArguments(op, input, {
                    tenantId: g.tenantId,
                    userId: g.userId,
                    employeeId: current.employeeId,
                  });
                  const result = await callJsonEndpoint(
                    cfg.baseUrl,
                    op.definition,
                    args,
                    current.apiToken,
                    g.executionId,
                    AbortSignal.any([
                      controller.signal,
                      AbortSignal.timeout(
                        Math.min(120000, Math.max(1, current.expiresAt - Date.now())),
                      ),
                    ]),
                    headers,
                  );
                  if (op.definition.kind === 'write')
                    await db.bridgeExecution.update({
                      where: { orgId_executionId: { orgId: g.orgId, executionId: g.executionId } },
                      data: { status: 'SUCCEEDED' },
                    });
                  return {
                    content: [
                      {
                        type: 'text' as const,
                        text: JSON.stringify(redact(result, [current.apiToken])),
                      },
                    ],
                  };
                } catch (error) {
                  if (op.definition.kind === 'write')
                    await db.bridgeExecution.update({
                      where: { orgId_executionId: { orgId: g.orgId, executionId: g.executionId } },
                      data: { status: 'FAILED_OR_UNKNOWN' },
                    });
                  throw new Error('Application API action failed; it was not retried');
                }
              },
            );
          }
        }
        return server;
      },
      { legacy: 'reject' },
    );
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (typeof value === 'string') headers.set(key, value);
    const request = new Request('http://bridge/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    const response = await handler.fetch(request);
    reply.hijack();
    reply.raw.statusCode = response.status;
    response.headers.forEach((v, k) => reply.raw.setHeader(k, v));
    if (response.body) await pipeline(Readable.fromWeb(response.body as any), reply.raw);
    else reply.raw.end();
  });
  app.addHook('onClose', async () => {
    await vault.close();
    await db.$disconnect();
  });
  return app;
}
