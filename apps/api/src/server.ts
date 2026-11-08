import { connectorCatalog } from '../../../packages/bridge/src/connector-catalog.js';
import { bridgeRoutes } from './bridge-management.js';
import { deploymentMode } from './bridge-client.js';
import Fastify from 'fastify';
import { requestContext, authenticateFirstParty } from './first-party.js';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import { authRoutes } from './auth-routes.js';
import { managementRoutes } from './management.js';
import { widgetRoutes } from './widget-routes.js';
import type { ModelStep } from './runtime.js';
import { fail } from './auth.js';
export async function createApp(
  options: { model?: ModelStep; staticRoot?: string; testRateLimitMax?: number } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 800000, requestTimeout: 130000 });
  app.addHook('onRequest', requestContext);
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/v1/widget/')) {
      const depId = req.headers['x-deployment-id'];
      if (typeof depId === 'string') {
        const dep = await db.deployment.findUnique({ where: { id: depId } });
        if (dep && (await deploymentMode(dep)) === 'hris-jwt') await authenticateFirstParty(req);
      } else if (config.FIRST_PARTY_JWKS_URL && !req.headers.authorization)
        fail(401, 'Assistant authentication required');
    }
    if (req.routeOptions.url === '/v1/widget-sessions') {
      const depId = (req.body as any)?.deploymentId;
      const dep =
        typeof depId === 'string' ? await db.deployment.findUnique({ where: { id: depId } }) : null;
      if (
        (dep && (await deploymentMode(dep)) === 'hris-jwt') ||
        (!dep && config.FIRST_PARTY_JWKS_URL)
      )
        fail(410, 'This deployment requires direct HRIS JWT authentication');
    }
  });
  await db.deployment.updateMany({
    where: { authMode: 'auto' },
    data: { authMode: config.FIRST_PARTY_JWKS_URL ? 'hris-jwt' : 'exchange' },
  });
  await app.register(cookie);
  await app.register(cors, {
    origin: true,
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-host-origin', 'x-deployment-id'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(rateLimit, {
    // Test fixtures simulate several complete users from one localhost IP.
    // Runtime deployments always retain the normal request limit.
    max: config.NODE_ENV === 'test' ? (options.testRateLimitMax ?? 100) : 100,
    timeWindow: '1 minute',
  });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/v1/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof ZodError)
      return reply
        .status(400)
        .send({ error: error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
    if (error.code === 'P2002' || error.code === 'P2034')
      return reply.status(409).send({ error: 'Conflicting change; refresh and try again' });
    const status = error.statusCode ?? 400;
    const message = error.code?.startsWith('P')
      ? 'Database operation failed'
      : (error.message ?? 'Request failed');
    reply.status(status >= 400 && status < 600 ? status : 500).send({ error: message });
  });
  app.get('/health', async () => {
    await db.$queryRaw`SELECT 1`;
    return { status: 'ok', aiConfigured: !!config.OPENAI_API_KEY };
  });
  await authRoutes(app);
  await managementRoutes(app);
  await bridgeRoutes(app);
  await widgetRoutes(app, options.model);
  const root = options.staticRoot ?? fileURLToPath(new URL('../../widget/dist', import.meta.url));
  app.get('/widget-assets/:file', async (req, reply) => {
    const file = (req.params as any).file;
    if (!['index.js', 'index.css', 'loader.js'].includes(file)) fail(404, 'Asset not found');
    return reply
      .type(file.endsWith('.css') ? 'text/css' : 'application/javascript')
      .send(await readFile(resolve(root, file), 'utf8'));
  });
  app.get('/host-connectors/:language', async (req, reply) => {
    const item = connectorCatalog.find((c) => c.id === (req.params as any).language);
    if (!item) fail(404, 'Unsupported connector language');
    return reply
      .type('text/plain; charset=utf-8')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${item.filename}"`)
      .send(
        await readFile(
          fileURLToPath(
            new URL('../../../integrations/host-connectors/' + item.source, import.meta.url),
          ),
          'utf8',
        ),
      );
  });
  app.get('/relay-server.d.mts', async (_req, reply) =>
    reply
      .type('text/plain')
      .header('Content-Disposition', 'attachment; filename=relay-server.d.mts')
      .send(
        await readFile(
          fileURLToPath(new URL('../../../packages/relay-server/connector.d.mts', import.meta.url)),
          'utf8',
        ),
      ),
  );
  app.get('/relay-server.mjs', async (_req, reply) =>
    reply
      .type('application/javascript')
      .header('Content-Disposition', 'attachment; filename=relay-server.mjs')
      .send(
        await readFile(
          fileURLToPath(new URL('../../../packages/relay-server/connector.mjs', import.meta.url)),
          'utf8',
        ),
      ),
  );
  app.get('/loader.js', async (_req, reply) =>
    reply.type('application/javascript').send(await readFile(resolve(root, 'loader.js'), 'utf8')),
  );
  app.get('/embed/:id', async (req, reply) => {
    const dep = await db.deployment.findFirst({
      where: { id: (req.params as any).id, active: true },
    });
    if (!dep) fail(404, 'Widget unavailable');
    reply.header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors ${[...dep.origins, config.WEB_ORIGIN].join(' ')}; base-uri 'none'; form-action 'none'`,
    );
    reply.type('text/html').send(await readFile(resolve(root, 'index.html'), 'utf8'));
  });
  return app;
}
export async function cleanup() {
  const now = new Date();
  await Promise.all([
    db.widgetSession.updateMany({
      where: {
        OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }],
        credential: { not: null },
      },
      data: { credential: null },
    }),
    db.dashboardSession.deleteMany({ where: { expiresAt: { lte: now } } }),
    db.passwordReset.deleteMany({ where: { expiresAt: { lte: now } } }),
    db.pendingAction.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    }),
  ]);
}
