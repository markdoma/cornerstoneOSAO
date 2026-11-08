import type { FastifyInstance } from 'fastify';
import { createIssuer, RequireInternalServiceContext } from './index.js';
export type HrisIssuer = Awaited<ReturnType<typeof createIssuer>>;
/** Mount on the HRIS server, using its existing session/authorization adapter. */
export async function registerHrisDelegation(
  app: FastifyInstance,
  options: {
    issuer: HrisIssuer;
    serviceToken: string;
    applicationOrigin: string;
    getSession: (
      request: any,
    ) => Promise<{ sub: string; tenant_id: string; roles: string[]; scopes: string[] } | null>;
  },
) {
  app.decorateRequest('userContext', null);
  app.get('/.well-known/jwks.json', async (_req, reply) =>
    reply.header('Cache-Control', 'public, max-age=300').send(options.issuer.jwks),
  );
  app.get('/api/internal/chat/session', async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
    // A same-origin cookie request only. Never derive identity from query parameters.
    if (
      (req.headers.origin && req.headers.origin !== options.applicationOrigin) ||
      (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
    )
      return reply.code(403).send({ error: 'Invalid application origin' });
    const session = await options.getSession(req);
    if (!session) return reply.code(401).send({ error: 'Sign in to use the assistant' });
    const user_context_token = await options.issuer.mint(session);
    return { user_context_token, expiresAt: new Date(Date.now() + 600000).toISOString() };
  });
  const gate = RequireInternalServiceContext({
    serviceToken: options.serviceToken,
    verify: options.issuer.verify,
  });
  app.addHook('preHandler', async (req) => {
    if (req.routeOptions.url?.startsWith('/internal/v1/')) {
      await gate(req);
      const required = (req.routeOptions.config as any).requiredScope;
      if (!required || !(req as any).userContext.scopes.includes(required))
        throw Object.assign(new Error('Internal action scope denied'), { statusCode: 403 });
    }
  });
}
