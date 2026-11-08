import { discoverBridgeTools } from './bridge-client.js';
import {
  deploymentMode,
  bridgeControl,
  sessionGrant,
  revokeBridgeCredential,
} from './bridge-client.js';
import { firstPartyContext, revokeFirstParty } from './first-party.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from './db.js';
import { hash, token, encrypt } from './crypto.js';
import { widget, owner, fail, conversationAccess } from './auth.js';
import { config } from './config.js';
import { runTurn, versionConfig, pendingPublic, type ModelStep } from './runtime.js';
import { redact } from './network.js';
export const sessionInput = z.object({
  deploymentId: z.string(),
  userId: z.string().min(1).max(200),
  tenantId: z.string().min(1).max(200).optional(),
  employeeId: z.string().min(1).max(200).optional(),
  origin: z.string(),
  toolIds: z.array(z.string()).max(40).optional(),
  useDeploymentTools: z.literal(true).optional(),
  apiToken: z
    .string()
    .min(1)
    .max(16000)
    .refine((x) => !/[\r\n]/.test(x), 'Token cannot contain line breaks'),
  apiTokenExpiresAt: z.iso.datetime(),
});
async function issueSession(data: z.infer<typeof sessionInput>, preview = false) {
  const deployment = await db.deployment.findUnique({ where: { id: data.deploymentId } });
  if (
    !deployment?.active ||
    (!deployment.origins.includes(data.origin) && !(preview && data.origin === config.WEB_ORIGIN))
  )
    fail(403, 'Deployment or embedding origin is not allowed');
  const version = await db.agentVersion.findFirst({
    where: { id: deployment.versionId, orgId: deployment.orgId },
  });
  if (!version) fail(404, 'Agent version not found');
  if (
    !(await db.agent.findFirst({
      where: { id: version.agentId, orgId: deployment.orgId, archived: false },
    }))
  )
    fail(403, 'Agent is archived');
  const allowed: string[] = (version.config as any).tools.map((t: any) => t.id);
  if ((data.toolIds === undefined) === (data.useDeploymentTools !== true))
    fail(400, 'Supply either toolIds or useDeploymentTools: true');
  const enabled = await db.tool.findMany({
    where: { orgId: deployment.orgId, id: { in: allowed }, enabled: true },
    select: { id: true },
  });
  const toolIds = data.toolIds ?? enabled.map((t) => t.id);
  if (new Set(toolIds).size !== toolIds.length || toolIds.some((id) => !allowed.includes(id)))
    fail(403, 'Requested tools exceed deployment permissions');
  if (
    (await db.tool.count({
      where: { id: { in: toolIds }, orgId: deployment.orgId, enabled: true },
    })) !== toolIds.length
  )
    fail(403, 'A requested tool is disabled');
  const expiresAt = new Date(Math.min(Date.now() + 300000, Date.parse(data.apiTokenExpiresAt)));
  if (expiresAt.getTime() < Date.now() + 5000)
    fail(400, 'Delegated token must be valid for at least five seconds');
  const mode = await deploymentMode(deployment);
  if (mode === 'hris-jwt') fail(410, 'Use direct HRIS authentication for this deployment');
  const bridgeTools = ((version.config as any).tools ?? []).filter((t: any) => t.bridgeRevisionId);
  if (mode === 'bridge-session') {
    if (!config.MCP_BRIDGE_ENABLED) fail(503, 'MCP bridge disabled');
    if (
      !data.tenantId ||
      !bridgeTools.length ||
      !(await db.bridgeTenant.findFirst({
        where: { tenantId: data.tenantId, orgId: deployment.orgId },
      }))
    )
      fail(403, 'Application tenant is not connected');
    const revisions = await db.bridgeRevision.findMany({
      where: {
        id: { in: bridgeTools.map((t: any) => t.bridgeRevisionId) },
        orgId: deployment.orgId,
      },
    });
    if (revisions.some((r) => (r.config as any).tenantId !== data.tenantId))
      fail(403, 'Published bridge tenant mismatch');
  }
  const raw = token();
  const session = await db.widgetSession.create({
    data: {
      orgId: deployment.orgId,
      deploymentId: deployment.id,
      versionId: deployment.versionId,
      userId: data.userId,
      origin: data.origin,
      toolIds,
      credential: mode === 'bridge-session' ? null : encrypt(data.apiToken),
      tenantId: mode === 'bridge-session' ? data.tenantId : null,
      employeeId: mode === 'bridge-session' ? data.employeeId : null,
      tokenHash: hash(raw),
      expiresAt,
    },
  });
  if (mode === 'bridge-session') {
    let bindingId: string | undefined;
    try {
      const result = await bridgeControl(
        '/control/credentials',
        sessionGrant(
          session,
          [...new Set(bridgeTools.map((t: any) => t.bridgeRevisionId))] as string[],
          'bind',
        ),
        {
          apiToken: data.apiToken,
          employeeId: data.employeeId,
          expiresAt: session.expiresAt.getTime(),
        },
      );
      bindingId = result.bindingId;
      await db.widgetSession.update({
        where: { id: session.id },
        data: { credentialHandle: bindingId },
      });
    } catch (error) {
      await db.widgetSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      if (bindingId)
        await revokeBridgeCredential({ ...session, credentialHandle: bindingId }).catch(() => {});
      throw error;
    }
  }
  return {
    token: raw,
    expiresAt: session.expiresAt,
    deploymentId: deployment.id,
    widgetOrigin: config.WIDGET_ORIGIN,
  };
}
export async function widgetRoutes(app: FastifyInstance, model?: ModelStep) {
  app.post('/v1/widget-sessions', async (req) => {
    const data = sessionInput.parse(req.body);
    const integration = req.headers.authorization;
    if (!integration?.startsWith('Bearer ')) fail(401, 'Integration key required');
    const deployment = await db.deployment.findFirst({
      where: { id: data.deploymentId, keyHash: hash(integration.slice(7)), active: true },
    });
    if (!deployment) fail(401, 'Invalid integration key');
    return issueSession(data);
  });
  app.post('/v1/deployments/:id/test-session', async (req) => {
    const s = await owner(req);
    const deploymentId = (req.params as any).id;
    const previewDep = await db.deployment.findFirst({
      where: { id: deploymentId, orgId: s.orgId },
    });
    if (previewDep && (await deploymentMode(previewDep)) !== 'exchange')
      fail(410, 'Test MCP tools inside the authenticated host application');
    if (!previewDep) fail(404, 'Deployment not found');
    const data = z
      .object({
        apiToken: z.string(),
        apiTokenExpiresAt: z.iso.datetime(),
        toolIds: z.array(z.string()),
      })
      .parse(req.body);
    return issueSession(
      sessionInput.parse({
        ...data,
        deploymentId,
        origin: config.WEB_ORIGIN,
        userId: `preview:${s.userId}`,
      }),
      true,
    );
  });
  app.post('/v1/widget/revoke', async (req) => {
    const s = await widget(req);
    if (firstPartyContext()) {
      revokeFirstParty();
      return { ok: true };
    }
    await revokeBridgeCredential(s).catch(() => {});
    await db.widgetSession.update({
      where: { id: s.id },
      data: { revokedAt: new Date(), credential: null },
    });
    return { ok: true };
  });
  app.get('/v1/widget/config', async (req) => {
    const s = await widget(req);
    const agent = await versionConfig(s);
    if (s.credentialHandle)
      await discoverBridgeTools(
        s,
        agent.tools.filter((t) => t.bridgeRevisionId && s.toolIds.includes(t.id)) as any,
        AbortSignal.timeout(10000),
      );
    const dep = await db.deployment.findUniqueOrThrow({ where: { id: s.deploymentId } });
    return {
      identity: hash(`${s.orgId}:${s.deploymentId}:${s.userId}`),
      agent: {
        name: agent.name,
        avatar: agent.avatar,
        welcome: agent.welcome,
        starters: agent.starters,
      },
      theme: dep.theme,
      bridgeTesting: !!s.credentialHandle,
      expiresAt: s.expiresAt,
    };
  });
  app.post('/v1/widget/conversations', async (req) => {
    const s = await widget(req);
    return db.conversation.create({
      data: {
        orgId: s.orgId,
        deploymentId: s.deploymentId,
        versionId: s.versionId,
        userId: s.userId,
      },
    });
  });
  app.get('/v1/widget/conversations/:id', async (req) => {
    const s = await widget(req);
    const id = (req.params as any).id;
    await conversationAccess(id, s);
    const agent = await versionConfig(s);
    const pending = await db.pendingAction.findFirst({
      where: { conversationId: id, status: 'PENDING', expiresAt: { gt: new Date() } },
    });
    return {
      messages: await db.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: 'asc' },
      }),
      pending: pending
        ? pendingPublic(
            pending,
            agent.tools.find((t) => t.id === pending.toolId)!,
          )
        : null,
    };
  });
  async function stream(
    req: FastifyRequest,
    reply: FastifyReply,
    approval: boolean,
    testing = false,
  ) {
    const s = await widget(req);
    const conversationId = (req.params as any).id;
    await conversationAccess(conversationId, s);
    const testData = testing
      ? z.object({ toolId: z.string(), arguments: z.unknown() }).strict().parse(req.body)
      : undefined;
    if (testData && !s.credentialHandle) fail(403, 'MCP test session required');
    const data = testData
      ? { text: 'Test selected application operation' }
      : approval
        ? z.object({ id: z.string(), approved: z.boolean() }).strict().parse(req.body)
        : z
            .object({ text: z.string().trim().min(1).max(12000) })
            .strict()
            .parse(req.body);
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
    // raw streaming must retain the CORS headers applied by Fastify.
    for (const [k, v] of Object.entries(reply.getHeaders()))
      if (v !== undefined) reply.raw.setHeader(k, v);
    reply.hijack();
    reply.raw.flushHeaders();
    const controller = new AbortController();
    reply.raw.on('close', () => controller.abort());
    const emit = (event: string, data: unknown) => {
      if (!reply.raw.destroyed)
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': keepalive\n\n');
    }, 15000);
    try {
      await runTurn({
        session: s,
        conversationId,
        ...(approval
          ? { approval: data as { id: string; approved: boolean } }
          : { text: (data as { text: string }).text }),
        emit,
        signal: controller.signal,
        model,
        ...(testData ? { testTool: { id: testData.toolId, arguments: testData.arguments } } : {}),
      });
    } catch (error: any) {
      const message = error?.statusCode
        ? error.message
        : /API|tool|turn|AI|Connected|response|Action|operation/i.test(error?.message ?? '')
          ? error.message
          : 'Unable to complete this turn; please try again';
      emit('error', { message: redact(message), status: error?.statusCode ?? 500 });
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
  }
  app.post('/v1/widget/conversations/:id/tool-test', async (req, reply) =>
    stream(req, reply, false, true),
  );
  app.post('/v1/widget/conversations/:id/messages', async (req, reply) =>
    stream(req, reply, false),
  );
  app.post('/v1/widget/conversations/:id/approve', async (req, reply) => stream(req, reply, true));
}
