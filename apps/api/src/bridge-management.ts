import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { owner, widget, fail } from './auth.js';
import { db } from './db.js';
import { config } from './config.js';
import { verifyDestination } from './network.js';
import {
  parseDraft,
  fingerprint,
  modelSchema,
  type BridgeConfig,
} from '../../../packages/bridge/src/contracts.js';
import { inventory, importSelection } from '../../../packages/bridge/src/openapi.js';
import { bridgeHealth, discoverBridgeTools, revokeBridgeCredential } from './bridge-client.js';
import { versionConfig } from './runtime.js';
const json = (v: unknown) => v as Prisma.InputJsonValue;
export async function bridgeRoutes(app: FastifyInstance) {
  const gate = () => {
    if (!config.MCP_BRIDGE_ENABLED) fail(503, 'MCP bridge setup is disabled by the platform');
  };
  app.get('/v1/bridges/status', async (req) => {
    await owner(req);
    if (!config.MCP_BRIDGE_ENABLED) return { enabled: false };
    try {
      return { enabled: true, ...(await bridgeHealth()) };
    } catch {
      return { enabled: true, status: 'unavailable' };
    }
  });
  app.get('/v1/bridges', async (req) => {
    const s = await owner(req);
    return db.bridge.findMany({ where: { orgId: s.orgId }, orderBy: { createdAt: 'desc' } });
  });
  app.post('/v1/bridges/import/inventory', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    gate();
    await owner(req);
    const { spec } = z.object({ spec: z.string() }).parse(req.body);
    return { operations: inventory(spec) };
  });
  app.post('/v1/bridges/import/review', { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    gate();
    await owner(req);
    const { spec, selected } = z
      .object({ spec: z.string(), selected: z.array(z.string()).min(1).max(40) })
      .parse(req.body);
    return { operations: importSelection(spec, selected) };
  });
  app.post('/v1/bridges', async (req) => {
    gate();
    const s = await owner(req);
    const draft = parseDraft(req.body);
    await verifyDestination(draft.baseUrl);
    return db.bridge.create({ data: { orgId: s.orgId, name: draft.name, draft: json(draft) } });
  });
  app.patch('/v1/bridges/:id', async (req) => {
    gate();
    const s = await owner(req);
    const draft = parseDraft(req.body);
    await verifyDestination(draft.baseUrl);
    const r = await db.bridge.updateMany({
      where: { id: (req.params as any).id, orgId: s.orgId },
      data: { name: draft.name, draft: json(draft) },
    });
    if (!r.count) fail(404, 'Bridge not found');
    return { ok: true };
  });
  app.get('/v1/bridges/:id/revisions', async (req) => {
    const s = await owner(req);
    return db.bridgeRevision.findMany({
      where: { bridgeId: (req.params as any).id, orgId: s.orgId },
      orderBy: { number: 'desc' },
    });
  });
  app.post('/v1/bridges/:id/publish', async (req) => {
    gate();
    const s = await owner(req);
    return db.$transaction(
      async (tx) => {
        const bridge = await tx.bridge.findFirst({
          where: { id: (req.params as any).id, orgId: s.orgId, active: true },
        });
        if (!bridge) fail(404, 'Bridge not found');
        const draft = parseDraft(bridge.draft);
        await verifyDestination(draft.baseUrl);
        if (!draft.operations.some((o) => o.enabled))
          fail(400, 'Explicitly enable at least one reviewed operation');
        const mappings = await tx.bridgeTenant.findMany({
          where: { OR: [{ tenantId: draft.tenantId }, { orgId: s.orgId }] },
        });
        if (mappings.some((m) => m.tenantId !== draft.tenantId || m.orgId !== s.orgId))
          fail(409, 'Each application tenant must have a distinct AO organization');
        if (!mappings.length)
          await tx.bridgeTenant.create({ data: { tenantId: draft.tenantId, orgId: s.orgId } });
        const last = await tx.bridgeRevision.findFirst({
          where: { bridgeId: bridge.id, orgId: s.orgId },
          orderBy: { number: 'desc' },
        });
        const revision = await tx.bridgeRevision.create({
          data: {
            bridgeId: bridge.id,
            orgId: s.orgId,
            number: (last?.number ?? 0) + 1,
            fingerprint: fingerprint(draft),
            config: json(draft),
          },
        });
        const connection = await tx.connection.create({
          data: {
            orgId: s.orgId,
            name: draft.name + ` · MCP v${revision.number}`,
            baseUrl: draft.baseUrl,
            bridgeRevisionId: revision.id,
          },
        });
        const tools = [];
        for (const op of draft.operations.filter((o) => o.enabled))
          tools.push(
            await tx.tool.create({
              data: {
                orgId: s.orgId,
                connectionId: connection.id,
                bridgeRevisionId: revision.id,
                bridgeOperationId: op.id,
                definition: json(op.definition),
                enabled: true,
              },
            }),
          );
        await tx.auditEvent.create({
          data: { orgId: s.orgId, userId: s.userId, kind: 'bridge_publish', status: 'SUCCEEDED' },
        });
        return { revision, connection, tools, origins: draft.origins };
      },
      { isolationLevel: 'Serializable' },
    );
  });
  app.post('/v1/bridges/:id/validate', async (req) => {
    gate();
    const s = await owner(req);
    const bridge = await db.bridge.findFirst({
      where: { id: (req.params as any).id, orgId: s.orgId },
    });
    if (!bridge) fail(404, 'Bridge not found');
    const draft = parseDraft(bridge.draft);
    await verifyDestination(draft.baseUrl);
    return {
      ...(await bridgeHealth()),
      operations: draft.operations.length,
      enabledOperations: draft.operations.filter((o) => o.enabled).length,
      sessionEndpoint: draft.sessionEndpoint,
      hostAuthentication:
        'Host session endpoint not verified. Verify inside the signed-in application; no user credential is substituted in setup.',
    };
  });
  app.post('/v1/bridges/:id/active', async (req) => {
    const s = await owner(req);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const id = (req.params as any).id;
    const result = await db.bridge.updateMany({ where: { id, orgId: s.orgId }, data: { active } });
    if (!result.count) fail(404, 'Bridge not found');
    if (!active) {
      const revisions = await db.bridgeRevision.findMany({
        where: { bridgeId: id, orgId: s.orgId },
        select: { id: true },
      });
      const tools = await db.tool.findMany({
        where: { orgId: s.orgId, bridgeRevisionId: { in: revisions.map((r) => r.id) } },
        select: { id: true },
      });
      const sessions = await db.widgetSession.findMany({
        where: { orgId: s.orgId, toolIds: { hasSome: tools.map((t) => t.id) }, revokedAt: null },
      });
      await db.widgetSession.updateMany({
        where: { id: { in: sessions.map((s) => s.id) }, orgId: s.orgId },
        data: { revokedAt: new Date(), credential: null },
      });
      await Promise.allSettled(sessions.map(revokeBridgeCredential));
    }
    return { ok: true };
  });
  app.post('/v1/connections/:id/migrate-to-bridge', async (req) => {
    gate();
    const s = await owner(req);
    const c = await db.connection.findFirst({
      where: { id: (req.params as any).id, orgId: s.orgId, bridgeRevisionId: null },
    });
    if (!c) fail(404, 'Direct API connection not found');
    const { tenantId, origins } = z
      .object({ tenantId: z.string().min(1), origins: z.array(z.string()).min(1) })
      .parse(req.body);
    const tools = await db.tool.findMany({ where: { connectionId: c.id, orgId: s.orgId } });
    if (tools.length > 40) fail(400, 'Select at most 40 operations in a new bridge draft');
    const draft = parseDraft({
      name: c.name + ' bridge',
      baseUrl: c.baseUrl,
      tenantId,
      origins,
      operations: tools.map((t) => ({
        id: t.id,
        definition: t.definition,
        bindings: [],
        enabled: t.enabled,
      })),
    });
    return db.bridge.create({ data: { orgId: s.orgId, name: draft.name, draft: json(draft) } });
  });
  app.get('/v1/widget/bridge-tools', async (req) => {
    const s = await widget(req);
    const agent = await versionConfig(s);
    const tools = agent.tools.filter(
      (t) => (t as any).bridgeRevisionId && s.toolIds.includes(t.id),
    );
    const discovered = await discoverBridgeTools(s, tools as any, AbortSignal.timeout(10000));
    return {
      status: 'authenticated',
      tools: discovered.map((t) => ({
        id: (t as any).id,
        name: t.name,
        schema: t.schema,
        revisionId: t.bridgeRevisionId,
        kind: t.kind,
      })),
    };
  });
}
