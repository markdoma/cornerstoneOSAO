import { deploymentMode, revokeBridgeCredential } from './bridge-client.js';
import {
  modelSchema,
  sessionEndpointInput,
  type BridgeConfig,
} from '../../../packages/bridge/src/contracts.js';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { agentInput, parseTool, importOpenAPI, themeInput, safeAvatar } from '@orchestrator/core';
import { db } from './db.js';
import { owner, fail } from './auth.js';
import { token, hash } from './crypto.js';
import { config } from './config.js';
import { verifyDestination } from './network.js';
const id = (req: any) => z.string().parse(req.params.id);
const json = (v: unknown) => v as Prisma.InputJsonValue;
function origin(v: string) {
  const u = new URL(v);
  if (
    u.origin !== v ||
    u.username ||
    u.password ||
    (u.protocol !== 'https:' &&
      !(
        config.NODE_ENV !== 'production' &&
        ['localhost', '127.0.0.1'].includes(u.hostname) &&
        u.protocol === 'http:'
      ))
  )
    throw new Error(
      'Use an exact HTTPS origin, without a trailing slash (localhost HTTP allowed in development)',
    );
  return v;
}
function requireLegacySetup() {
  if (!config.LEGACY_DIRECT_SETUP_ENABLED)
    fail(410, 'Direct API setup is retired. Use MCP Bridges to import, review and publish tools.');
}
function requireMcpTools(tools: { bridgeRevisionId?: string | null }[]) {
  if (tools.some((t) => !t.bridgeRevisionId)) requireLegacySetup();
}
export async function managementRoutes(app: FastifyInstance) {
  app.get('/v1/overview', async (req) => {
    const { orgId } = await owner(req);
    const [agents, deployments, conversations, actions, usage, events] = await Promise.all([
      db.agent.count({ where: { orgId, archived: false } }),
      db.deployment.count({ where: { orgId, active: true } }),
      db.conversation.count({ where: { orgId } }),
      db.auditEvent.count({ where: { orgId, kind: 'tool' } }),
      db.usage.aggregate({ where: { orgId }, _sum: { inputTokens: true, outputTokens: true } }),
      db.auditEvent.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    ]);
    return { agents, deployments, conversations, actions, usage: usage._sum, events };
  });
  app.get('/v1/organizations', async (req) => {
    const s = await owner(req);
    const memberships = await db.membership.findMany({ where: { userId: s.userId } });
    return db.organization.findMany({ where: { id: { in: memberships.map((m) => m.orgId) } } });
  });
  app.post('/v1/organizations/switch', async (req) => {
    const s = await owner(req);
    const { orgId } = z.object({ orgId: z.string() }).parse(req.body);
    if (!(await db.membership.findUnique({ where: { userId_orgId: { userId: s.userId, orgId } } })))
      fail(403, 'Organization access denied');
    await db.dashboardSession.update({
      where: { tokenHash: hash(req.cookies.session!) },
      data: { orgId },
    });
    return { ok: true };
  });
  app.get('/v1/members', async (req) => {
    const s = await owner(req);
    const memberships = await db.membership.findMany({ where: { orgId: s.orgId } });
    const users = await db.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, email: true, name: true },
    });
    return memberships.map((m) => ({ ...m, user: users.find((u) => u.id === m.userId) }));
  });
  app.post('/v1/members', async (req) => {
    const s = await owner(req, true);
    const { email } = z
      .object({ email: z.email().transform((x) => x.toLowerCase()) })
      .parse(req.body);
    const user = await db.user.findUnique({ where: { email } });
    if (!user) fail(404, 'Ask this person to create an account first');
    await db.membership.upsert({
      where: { userId_orgId: { userId: user.id, orgId: s.orgId } },
      create: { userId: user.id, orgId: s.orgId, role: 'ADMIN' },
      update: {},
    });
    return { ok: true };
  });
  app.delete('/v1/members/:id', async (req) => {
    const s = await owner(req, true);
    await db.membership.deleteMany({ where: { id: id(req), orgId: s.orgId, role: 'ADMIN' } });
    return { ok: true };
  });
  app.get('/v1/agents', async (req) => {
    const s = await owner(req);
    return db.agent.findMany({ where: { orgId: s.orgId }, orderBy: { updatedAt: 'desc' } });
  });
  async function draft(raw: unknown, orgId: string) {
    const data = agentInput.parse(raw);
    if (!safeAvatar(data.avatar)) fail(400, 'Use an uploaded PNG, JPEG, or WebP avatar');
    if (!config.models.includes(data.model)) fail(400, 'Model is not enabled by the platform');
    if (
      new Set(data.toolIds).size !== data.toolIds.length ||
      (await db.tool.count({ where: { orgId, id: { in: data.toolIds }, enabled: true } })) !==
        data.toolIds.length
    )
      fail(400, 'Select enabled tools belonging to this organization');
    const selectedTools = await db.tool.findMany({
      where: { orgId, id: { in: data.toolIds } },
      select: { bridgeRevisionId: true },
    });
    requireMcpTools(selectedTools);
    return data;
  }
  app.post('/v1/agents', async (req) => {
    const s = await owner(req);
    return db.agent.create({
      data: { orgId: s.orgId, draft: json(await draft(req.body, s.orgId)) },
    });
  });
  app.patch('/v1/agents/:id', async (req) => {
    const s = await owner(req);
    if (!(await db.agent.findFirst({ where: { id: id(req), orgId: s.orgId, archived: false } })))
      fail(404, 'Agent not found');
    const data = await draft(req.body, s.orgId);
    const result = await db.agent.updateMany({
      where: { id: id(req), orgId: s.orgId, archived: false },
      data: { draft: json(data) },
    });
    if (!result.count) fail(404, 'Agent not found');
    return { ok: true };
  });
  app.post('/v1/agents/:id/archive', async (req) => {
    const s = await owner(req);
    const result = await db.agent.updateMany({
      where: { id: id(req), orgId: s.orgId },
      data: { archived: true },
    });
    if (!result.count) fail(404, 'Agent not found');
    return { ok: true };
  });
  app.get('/v1/agents/:id/versions', async (req) => {
    const s = await owner(req);
    return db.agentVersion.findMany({
      where: { agentId: id(req), orgId: s.orgId },
      orderBy: { number: 'desc' },
    });
  });
  app.post('/v1/agents/:id/publish', async (req) => {
    const s = await owner(req);
    return db.$transaction(
      async (tx) => {
        const agent = await tx.agent.findFirst({
          where: { id: id(req), orgId: s.orgId, archived: false },
        });
        if (!agent) fail(404, 'Agent not found');
        const data = agentInput.parse(agent.draft);
        if (!config.models.includes(data.model)) fail(400, 'Model is no longer enabled');
        const tools = await tx.tool.findMany({
          where: { id: { in: data.toolIds }, orgId: s.orgId, enabled: true },
        });
        if (tools.length !== data.toolIds.length)
          fail(400, 'A selected tool is disabled or missing');
        requireMcpTools(tools);
        const names = tools.map((t) => (t.definition as any).name);
        if (new Set(names).size !== names.length) fail(400, 'Selected tool names must be unique');
        const connections = await tx.connection.findMany({
          where: { orgId: s.orgId, id: { in: tools.map((t) => t.connectionId) } },
        });
        const revisions = await tx.bridgeRevision.findMany({
          where: {
            orgId: s.orgId,
            id: { in: tools.flatMap((t) => (t.bridgeRevisionId ? [t.bridgeRevisionId] : [])) },
          },
        });
        const endpoints = [
          ...new Set(
            revisions.map((r) =>
              sessionEndpointInput.parse(
                (r.config as unknown as BridgeConfig).sessionEndpoint ?? '/assistant/session',
              ),
            ),
          ),
        ];
        if (endpoints.length > 1)
          fail(400, 'Selected MCP bridges must use the same host session endpoint');
        const frozenTools = tools.map((t) => ({
          id: t.id,
          ...parseTool(t.definition),
          connectionId: t.connectionId,
          baseUrl: connections.find((c) => c.id === t.connectionId)!.baseUrl,
          ...(t.bridgeRevisionId
            ? (() => {
                const revision = revisions.find((r) => r.id === t.bridgeRevisionId);
                const op = (revision?.config as unknown as BridgeConfig)?.operations.find(
                  (o) => o.id === t.bridgeOperationId && o.enabled,
                );
                if (!revision || !op) fail(400, 'Bridge operation is unavailable');
                return {
                  bridgeRevisionId: revision.id,
                  bridgeOperationId: op.id,
                  bridgeFingerprint: revision.fingerprint,
                  schema: modelSchema(op),
                };
              })()
            : {}),
        }));
        if (
          frozenTools.some((t) => t.bridgeRevisionId) &&
          frozenTools.some((t) => !t.bridgeRevisionId)
        )
          fail(
            400,
            'Use bridge tools only in a bridge-backed version; direct deployments remain separate',
          );
        const last = await tx.agentVersion.findFirst({
          where: { agentId: agent.id },
          orderBy: { number: 'desc' },
        });
        return tx.agentVersion.create({
          data: {
            orgId: s.orgId,
            agentId: agent.id,
            number: (last?.number ?? 0) + 1,
            config: json({
              ...data,
              tools: frozenTools,
              ...(endpoints.length ? { hostSessionEndpoint: endpoints[0] } : {}),
            }),
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );
  });
  app.get('/v1/connections', async (req) => {
    const s = await owner(req);
    return db.connection.findMany({ where: { orgId: s.orgId }, orderBy: { createdAt: 'desc' } });
  });
  app.post('/v1/connections', async (req) => {
    const s = await owner(req);
    requireLegacySetup();
    const data = z
      .object({ name: z.string().min(1).max(100), baseUrl: z.url().max(1000) })
      .parse(req.body);
    await verifyDestination(data.baseUrl);
    return db.connection.create({
      data: { ...data, baseUrl: data.baseUrl.replace(/\/$/, ''), orgId: s.orgId },
    });
  });
  app.get('/v1/tools', async (req) => {
    const s = await owner(req);
    return db.tool.findMany({ where: { orgId: s.orgId }, orderBy: { createdAt: 'asc' } });
  });
  app.post('/v1/tools/import', async (req) => {
    await owner(req);
    requireLegacySetup();
    const { spec } = z.object({ spec: z.string().max(500000) }).parse(req.body);
    return { tools: importOpenAPI(spec) };
  });
  app.post('/v1/tools', async (req) => {
    const s = await owner(req);
    requireLegacySetup();
    const data = z
      .object({
        connectionId: z.string(),
        definition: z.unknown(),
        enabled: z.boolean().default(false),
      })
      .parse(req.body);
    const connection = await db.connection.findFirst({
      where: { id: data.connectionId, orgId: s.orgId },
    });
    if (!connection) fail(404, 'Connection not found');
    if (connection.bridgeRevisionId) fail(400, 'Edit MCP operations in a new bridge draft');
    return db.tool.create({
      data: {
        orgId: s.orgId,
        connectionId: data.connectionId,
        definition: json(parseTool(data.definition)),
        enabled: data.enabled,
      },
    });
  });
  app.patch('/v1/tools/:id', async (req) => {
    const s = await owner(req);
    const existing = await db.tool.findFirst({ where: { id: id(req), orgId: s.orgId } });
    if (!existing) fail(404, 'Tool not found');
    if ((req.body as any)?.definition) {
      if (existing.bridgeRevisionId) fail(400, 'Edit MCP operations in a new bridge draft');
      requireLegacySetup();
    }
    const data = z
      .object({ definition: z.unknown().optional(), enabled: z.boolean().optional() })
      .parse(req.body);
    const updated = await db.tool.updateMany({
      where: { id: id(req), orgId: s.orgId },
      data: {
        ...(data.definition ? { definition: json(parseTool(data.definition)) } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      },
    });
    if (!updated.count) fail(404, 'Tool not found');
    return { ok: true };
  });
  const publicDeployment = {
    id: true,
    orgId: true,
    versionId: true,
    name: true,
    origins: true,
    theme: true,
    active: true,
    createdAt: true,
    authMode: true,
  } as const;
  app.get('/v1/deployments', async (req) => {
    const s = await owner(req);
    return db.deployment.findMany({
      where: { orgId: s.orgId },
      select: publicDeployment,
      orderBy: { createdAt: 'desc' },
    });
  });
  app.get('/v1/deployments/:id/integration', async (req) => {
    const s = await owner(req);
    const deployment = await db.deployment.findFirst({ where: { id: id(req), orgId: s.orgId } });
    if (!deployment) fail(404, 'Deployment not found');
    const version = await db.agentVersion.findFirstOrThrow({
      where: { id: deployment.versionId, orgId: s.orgId },
    });
    const published = version.config as any;
    const authMode = await deploymentMode(deployment);
    const tenant =
      authMode === 'bridge-session'
        ? await db.bridgeTenant.findUnique({
            where: { orgId: s.orgId },
            select: { tenantId: true },
          })
        : null;
    return {
      authMode,
      deploymentId: deployment.id,
      ...(authMode === 'bridge-session'
        ? {
            sessionEndpoint: published.hostSessionEndpoint ?? '/assistant/session',
            tenantId: tenant?.tenantId,
            origins: deployment.origins,
          }
        : {}),
      toolIds: published.toolIds,
      tools: published.tools.map((tool: any) => ({ id: tool.id, name: tool.name })),
    };
  });
  app.post('/v1/deployments', async (req) => {
    const s = await owner(req);
    const data = z
      .object({
        versionId: z.string(),
        name: z.string().min(1).max(100),
        origins: z.array(z.string().transform(origin)).min(1).max(20),
        theme: themeInput,
      })
      .parse(req.body);
    if (!(await db.agentVersion.findFirst({ where: { id: data.versionId, orgId: s.orgId } })))
      fail(404, 'Published version not found');
    const version = await db.agentVersion.findFirstOrThrow({
      where: { id: data.versionId, orgId: s.orgId },
    });
    requireMcpTools((version.config as any).tools ?? []);
    const bridgeTools = ((version.config as any).tools ?? []).filter(
      (t: any) => t.bridgeRevisionId,
    );
    const authMode = bridgeTools.length
      ? 'bridge-session'
      : config.FIRST_PARTY_JWKS_URL
        ? 'hris-jwt'
        : 'exchange';
    if (bridgeTools.length) {
      if (!config.MCP_BRIDGE_ENABLED) fail(503, 'MCP bridge disabled');
      const revisions = await db.bridgeRevision.findMany({
        where: { id: { in: bridgeTools.map((t: any) => t.bridgeRevisionId) }, orgId: s.orgId },
      });
      if (
        data.origins.some((o) =>
          revisions.some((r) => !(r.config as unknown as BridgeConfig).origins.includes(o)),
        )
      )
        fail(400, 'Deployment origins must be allowed in every bridge revision');
    }
    const integrationKey = token();
    const deployment = await db.deployment.create({
      data: {
        ...data,
        authMode,
        orgId: s.orgId,
        theme: json(data.theme),
        keyHash: hash(integrationKey),
      },
      select: publicDeployment,
    });
    return { ...deployment, integrationKey };
  });
  app.patch('/v1/deployments/:id', async (req) => {
    const s = await owner(req);
    const data = z
      .object({
        active: z.boolean().optional(),
        theme: themeInput.optional(),
        origins: z.array(z.string().transform(origin)).min(1).max(20).optional(),
        versionId: z.string().optional(),
      })
      .parse(req.body);
    if (
      data.versionId &&
      !(await db.agentVersion.findFirst({ where: { id: data.versionId, orgId: s.orgId } }))
    )
      fail(404, 'Version not found');
    const existing = await db.deployment.findFirst({ where: { id: id(req), orgId: s.orgId } });
    if (!existing) fail(404, 'Deployment not found');
    const nextVersion = await db.agentVersion.findFirstOrThrow({
      where: { id: data.versionId ?? existing.versionId, orgId: s.orgId },
    });
    if (data.versionId && data.versionId !== existing.versionId)
      requireMcpTools((nextVersion.config as any).tools ?? []);
    const mcpTools = ((nextVersion.config as any).tools ?? []).filter(
      (t: any) => t.bridgeRevisionId,
    );
    if (mcpTools.length) {
      if (!config.MCP_BRIDGE_ENABLED) fail(503, 'MCP bridge disabled');
      const revisions = await db.bridgeRevision.findMany({
        where: { id: { in: mcpTools.map((t: any) => t.bridgeRevisionId) }, orgId: s.orgId },
      });
      if (
        (data.origins ?? existing.origins).some((o) =>
          revisions.some((r) => !(r.config as unknown as BridgeConfig).origins.includes(o)),
        )
      )
        fail(400, 'Embedding origin exceeds bridge configuration');
    }
    const result = await db.deployment.updateMany({
      where: { id: id(req), orgId: s.orgId },
      data: {
        ...data,
        ...(data.versionId
          ? {
              authMode: mcpTools.length
                ? 'bridge-session'
                : config.FIRST_PARTY_JWKS_URL
                  ? 'hris-jwt'
                  : 'exchange',
            }
          : {}),
        theme: data.theme ? json(data.theme) : undefined,
      },
    });
    if (data.active === false || data.versionId || data.origins) {
      const sessions = await db.widgetSession.findMany({
        where: { deploymentId: id(req), orgId: s.orgId, revokedAt: null },
      });
      await db.widgetSession.updateMany({
        where: { deploymentId: id(req), orgId: s.orgId },
        data: { revokedAt: new Date(), credential: null },
      });
      await Promise.allSettled(sessions.map(revokeBridgeCredential));
    }
    if (!result.count) fail(404, 'Deployment not found');
    return { ok: true };
  });
  app.post('/v1/deployments/:id/rotate-key', async (req) => {
    const s = await owner(req, true);
    const key = token();
    const result = await db.deployment.updateMany({
      where: { id: id(req), orgId: s.orgId },
      data: { keyHash: hash(key) },
    });
    if (!result.count) fail(404, 'Deployment not found');
    const previousSessions = await db.widgetSession.findMany({
      where: { deploymentId: id(req), orgId: s.orgId, revokedAt: null },
    });
    await Promise.allSettled(previousSessions.map(revokeBridgeCredential));
    await db.widgetSession.updateMany({
      where: { deploymentId: id(req), orgId: s.orgId },
      data: { revokedAt: new Date(), credential: null },
    });
    return { integrationKey: key };
  });
  app.get('/v1/conversations', async (req) => {
    const s = await owner(req);
    return db.conversation.findMany({
      where: { orgId: s.orgId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });
  app.get('/v1/conversations/:id', async (req) => {
    const s = await owner(req);
    if (!(await db.conversation.findFirst({ where: { id: id(req), orgId: s.orgId } })))
      fail(404, 'Conversation not found');
    return db.message.findMany({
      where: { conversationId: id(req) },
      orderBy: { createdAt: 'asc' },
    });
  });
}
