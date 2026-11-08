import { sessionEndpointInput } from '../../../packages/bridge/src/contracts.js';
import { registerHrisDelegation, type HrisIssuer } from '../../../packages/delegation/src/hris.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  createRelaySessionHandler,
  type HostSession,
} from '../../../packages/relay-server/connector.mjs';
const random = () => randomBytes(32).toString('base64url');
// Deployment IDs are Prisma CUIDs. Never render an accidental credential as a public ID.
const validDeploymentId = (value: string) => /^c[a-z0-9]{24}$/.test(value);
type Task = { id: string; userId: string; title: string; done: boolean };
export async function createHost(options: {
  apiUrl: string;
  widgetOrigin: string;
  origin: string;
  integrationKey: string;
  deploymentId: string;
  toolIds: string[];
  tenantId?: string;
  sessionEndpoint?: string;
  firstParty?: { issuer: HrisIssuer; serviceToken: string; tenantId: string };
}) {
  const sessionEndpoint = sessionEndpointInput.parse(
    options.sessionEndpoint ?? '/assistant/session',
  );
  const app = Fastify({ logger: false, bodyLimit: 20000 });
  await app.register(cookie);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  const sessions = new Map<string, { userId: string; expiresAt: number; widgets: string[] }>(),
    tokens = new Map<string, { userId: string; expiresAt: number }>();
  const tasks: Task[] = [
    { id: random(), userId: 'alice', title: 'Prepare the product launch', done: false },
    { id: random(), userId: 'bob', title: 'Review customer feedback', done: false },
  ];
  function fail(status: number, message: string): never {
    throw Object.assign(new Error(message), { statusCode: status });
  }
  const hostUser = (req: any) => {
    const s = sessions.get(req.cookies.host_session);
    if (!s || s.expiresAt <= Date.now()) fail(401, 'Please sign in');
    return s;
  };
  const apiUser = (req: any) => {
    const value = req.headers.authorization?.slice(7);
    const t = tokens.get(value);
    if (!t || t.expiresAt <= Date.now() || !req.headers.authorization?.startsWith('Bearer '))
      fail(401, 'API token expired');
    return t.userId;
  };
  const checkOrigin = (req: any) => {
    if (req.headers.origin !== options.origin) fail(403, 'Invalid host origin');
  };
  async function revoke(token: string) {
    await fetch(`${options.apiUrl}/v1/widget/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-host-origin': options.origin },
    }).catch(() => {});
  }
  app.setErrorHandler((e: any, _req, reply) =>
    reply
      .status(e instanceof z.ZodError ? 400 : (e.statusCode ?? 500))
      .send({ error: e instanceof z.ZodError ? 'Invalid input' : e.message }),
  );
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
  });
  app.post('/login', async (req, reply) => {
    checkOrigin(req);
    const { user } = z.object({ user: z.enum(['alice', 'bob']) }).parse(req.body);
    const raw = random();
    sessions.set(raw, { userId: user, expiresAt: Date.now() + 3600000, widgets: [] });
    reply.setCookie('host_session', raw, {
      httpOnly: true,
      sameSite: 'lax',
      secure: options.origin.startsWith('https:'),
      path: '/',
    });
    return { ok: true };
  });
  app.get('/me', async (req) => {
    const s = hostUser(req);
    return {
      user: s.userId,
      tasks: tasks.filter((t) => t.userId === s.userId),
      configured:
        (!!options.firstParty || !!options.integrationKey) &&
        validDeploymentId(options.deploymentId),
    };
  });
  app.post('/logout', async (req, reply) => {
    checkOrigin(req);
    const s = hostUser(req);
    sessions.delete(req.cookies.host_session!);
    for (const [key, t] of tokens) if (t.userId === s.userId) tokens.delete(key);
    await Promise.all(s.widgets.map(revoke));
    reply.clearCookie('host_session', { path: '/' });
    return { ok: true };
  });
  const sessionOwners = new WeakMap<HostSession, string[]>();
  const assistant =
    options.integrationKey && validDeploymentId(options.deploymentId)
      ? createRelaySessionHandler({
          relayOrigin: options.apiUrl,
          widgetOrigin: options.widgetOrigin,
          applicationOrigin: options.origin,
          deploymentId: options.deploymentId,
          integrationKey: options.integrationKey,
          allowLocalhost: true,
          getSession: async (request) => {
            const cookie = app.parseCookie(request.headers.get('cookie') ?? '').host_session;
            const s = cookie ? sessions.get(cookie) : undefined;
            if (!s || s.expiresAt <= Date.now()) return null;
            const apiToken = random(),
              expiry = Math.min(s.expiresAt, Date.now() + 300000);
            tokens.set(apiToken, { userId: s.userId, expiresAt: expiry });
            const verified: HostSession = {
              userId: s.userId,
              tenantId: options.tenantId,
              apiToken,
              expiresAt: new Date(expiry).toISOString(),
              ...(options.toolIds.length ? { toolIds: options.toolIds } : {}),
              isActive: () => sessions.get(cookie!) === s && s.expiresAt > Date.now(),
            };
            sessionOwners.set(verified, s.widgets);
            return verified;
          },
          onSessionIssued: (access, session) => {
            sessionOwners.get(session)!.push(access.token);
          },
        })
      : null;
  app.post(sessionEndpoint, async (req, reply) => {
    if (!assistant)
      fail(503, 'Connect this host once with SAMPLE_INTEGRATION_KEY and SAMPLE_DEPLOYMENT_ID');
    const response = await assistant(
      new Request(`${options.origin}${sessionEndpoint}`, {
        method: 'POST',
        headers: {
          origin: String(req.headers.origin ?? ''),
          'content-type': req.headers['content-type'] ?? '',
          cookie: req.headers.cookie ?? '',
        },
        body: JSON.stringify(req.body ?? {}),
      }),
    );
    return reply
      .status(response.status)
      .headers(Object.fromEntries(response.headers))
      .send(await response.text());
  });
  app.post('/demo/token', async (req) => {
    checkOrigin(req);
    const s = hostUser(req),
      raw = random(),
      expiresAt = Date.now() + 300000;
    tokens.set(raw, { userId: s.userId, expiresAt });
    return { apiToken: raw, expiresAt: new Date(expiresAt).toISOString() };
  });
  app.get('/api/tasks', async (req) => {
    const userId = apiUser(req);
    return { tasks: tasks.filter((t) => t.userId === userId) };
  });
  app.get('/api/tasks/:id', async (req) => {
    const userId = apiUser(req);
    const task = tasks.find((t) => t.id === (req.params as any).id && t.userId === userId);
    if (!task) fail(404, 'Task not found');
    return task;
  });
  app.post('/api/tasks', async (req) => {
    const userId = apiUser(req),
      data = z
        .object({ title: z.string().min(1).max(200) })
        .strict()
        .parse(req.body);
    const task = { id: random(), userId, title: data.title, done: false };
    tasks.push(task);
    return task;
  });
  app.patch('/api/tasks/:id', async (req) => {
    const userId = apiUser(req),
      task = tasks.find((t) => t.id === (req.params as any).id && t.userId === userId);
    if (!task) fail(404, 'Task not found');
    const data = z
      .object({ title: z.string().min(1).max(200).optional(), done: z.boolean().optional() })
      .strict()
      .parse(req.body);
    Object.assign(task, data);
    return task;
  });
  app.delete('/api/tasks/:id', async (req) => {
    const userId = apiUser(req),
      index = tasks.findIndex((t) => t.id === (req.params as any).id && t.userId === userId);
    if (index < 0) fail(404, 'Task not found');
    tasks.splice(index, 1);
    return { deleted: true };
  });
  if (options.firstParty) {
    const { issuer, serviceToken, tenantId } = options.firstParty;
    await registerHrisDelegation(app, {
      issuer,
      serviceToken,
      applicationOrigin: options.origin,
      getSession: async (req) => {
        try {
          const s = hostUser(req);
          return {
            sub: s.userId,
            tenant_id: tenantId,
            roles: ['employee'],
            scopes: [
              'tool:list_tasks',
              'tool:get_task',
              'tool:create_task',
              'tool:update_task',
              'tool:delete_task',
            ],
          };
        } catch {
          return null;
        }
      },
    });
    const context = (req: any) => {
      const c = req.userContext;
      if (c.tenant_id !== tenantId) fail(403, 'Tenant access denied');
      return c;
    };
    const record = (req: any) => {
      const c = context(req);
      const task = tasks.find((t) => t.id === req.params.id);
      if (!task || task.userId !== c.sub) fail(403, 'Record access denied');
      return task;
    };
    app.get(
      '/internal/v1/tasks',
      { config: { requiredScope: 'tool:list_tasks' } },
      async (req) => ({ tasks: tasks.filter((t) => t.userId === context(req).sub) }),
    );
    app.get('/internal/v1/tasks/:id', { config: { requiredScope: 'tool:get_task' } }, async (req) =>
      record(req),
    );
    app.post(
      '/internal/v1/tasks',
      { config: { requiredScope: 'tool:create_task' } },
      async (req) => {
        const c = context(req);
        const data = z
          .object({ title: z.string().min(1).max(200), tenant_id: z.literal(tenantId) })
          .strict()
          .parse(req.body);
        const task = { id: random(), userId: c.sub, title: data.title, done: false };
        tasks.push(task);
        return task;
      },
    );
    app.patch(
      '/internal/v1/tasks/:id',
      { config: { requiredScope: 'tool:update_task' } },
      async (req) => {
        const task = record(req);
        const { tenant_id, ...data } = z
          .object({
            title: z.string().min(1).max(200).optional(),
            done: z.boolean().optional(),
            tenant_id: z.literal(tenantId),
          })
          .strict()
          .parse(req.body);
        Object.assign(task, data);
        return task;
      },
    );
    app.delete(
      '/internal/v1/tasks/:id',
      { config: { requiredScope: 'tool:delete_task' } },
      async (req) => {
        const task = record(req);
        tasks.splice(tasks.indexOf(task), 1);
        return { deleted: true };
      },
    );
  }
  app.get('/openapi.json', async () => {
    const spec = sampleSpecification(options.origin);
    if (options.firstParty) spec.servers = [{ url: options.origin + '/internal/v1' }];
    return spec;
  });
  app.get('/', async (_req, reply) =>
    reply
      .type('text/html')
      .send(
        page(options.widgetOrigin, options.deploymentId, !!options.firstParty, sessionEndpoint),
      ),
  );
  const timer = setInterval(() => {
    for (const [k, t] of tokens) if (t.expiresAt <= Date.now()) tokens.delete(k);
    for (const [k, s] of sessions)
      if (s.expiresAt <= Date.now()) {
        sessions.delete(k);
        void Promise.all(s.widgets.map(revoke));
      }
  }, 30000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
  return app;
}
export function sampleSpecification(origin: string) {
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  return {
    openapi: '3.0.3',
    info: { title: 'Sample tasks API', version: '1.0.0' },
    servers: [{ url: origin + '/api' }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/tasks': {
        get: {
          operationId: 'list_tasks',
          summary: 'List my tasks',
          responses: { '200': { description: 'My tasks' } },
        },
        post: {
          operationId: 'create_task',
          summary: 'Create a task',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
                  required: ['title'],
                  additionalProperties: false,
                },
              },
            },
          },
          responses: { '200': { description: 'Created task' } },
        },
      },
      '/tasks/{id}': {
        get: {
          operationId: 'get_task',
          summary: 'Read one of my tasks',
          parameters: [id],
          responses: { '200': { description: 'Task' } },
        },
        patch: {
          operationId: 'update_task',
          summary: 'Update one of my tasks',
          parameters: [id],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', minLength: 1, maxLength: 200 },
                    done: { type: 'boolean' },
                  },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: { '200': { description: 'Updated task' } },
        },
        delete: {
          operationId: 'delete_task',
          summary: 'Delete one of my tasks',
          parameters: [id],
          responses: { '200': { description: 'Deleted' } },
        },
      },
    },
  };
}
function page(
  widgetOrigin: string,
  deploymentId: string,
  firstParty = false,
  sessionEndpoint = '/assistant/session',
) {
  const script = validDeploymentId(deploymentId)
    ? `<script src="${widgetOrigin.replaceAll('"', '&quot;')}/loader.js" data-deployment="${deploymentId.replaceAll('"', '&quot;')}" ${firstParty ? 'data-auth="hris-jwt"' : `data-session-endpoint="${sessionEndpoint}"`} defer></script>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Taskboard · CornerstoneLabs AO sample host</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f7fb;color:#25263c;font:14px system-ui,sans-serif}header{background:white;border-bottom:1px solid #e8e7f1;padding:22px 7%;display:flex;align-items:center;gap:12px}header strong{font-size:20px}header span{font-size:10px;color:#9484b6;background:#f3effc;padding:6px 8px;border-radius:5px}main{max-width:900px;margin:65px auto;padding:0 24px}h1{font-size:38px;letter-spacing:-1.5px}p{color:#8c859d;line-height:1.8}button,a{font:inherit}button{background:#7560e8;color:white;border:0;border-radius:8px;padding:11px 18px;cursor:pointer;margin:5px}button.secondary{background:#eeeafa;color:#8875a6}section{background:white;border:1px solid #e7e3ef;padding:30px;border-radius:14px;margin-top:30px}li{padding:18px 0;border-bottom:1px solid #f0ebf6}small{color:#a38eb4;font-size:11px}pre{overflow-wrap:anywhere;white-space:pre-wrap;background:#f5f0fc;padding:14px;border-radius:8px;font-size:11px}a{color:#8f72b5}#error{color:#b85279}#logout{margin-left:auto}#user{font-size:13px;font-weight:500;margin-left:auto}.hidden{display:none!important}</style></head><body><header><strong>◈ Taskboard</strong><span>SAMPLE APPLICATION</span><span id="user" class="hidden"></span><button id="logout" class="secondary hidden">Sign out</button></header><main><small>YOUR APP + YOUR AI ASSISTANT</small><h1>A little help with the day ahead.</h1><p>This application has its own login and user-scoped tasks. CornerstoneLabs AO verifies that login before displaying your assistant.</p><div id="error" role="alert"></div><section id="login"><h2>Choose a demo account</h2><p>These accounts have separate tasks. The assistant can only access the signed-in user’s data.</p><button data-user="alice">Sign in as Alice</button><button data-user="bob" class="secondary">Sign in as Bob</button><p><small>Demo identities only. This sample stores tasks and sessions in memory.</small></p></section><section id="tasks" class="hidden"><h2>Your tasks</h2><ul id="list"></ul><button id="refresh" class="secondary">Refresh tasks</button><button id="test-token" class="secondary">Get playground token</button><pre id="token" class="hidden"></pre><p id="setup" class="hidden">Set SAMPLE_DEPLOYMENT_ID and SAMPLE_INTEGRATION_KEY in the root .env, then restart this host to enable the widget.</p></section><p><a href="/openapi.json" download="sample-openapi.json">Download sample OpenAPI specification</a> · <a href="http://localhost:3000">Open CornerstoneLabs AO dashboard ↗</a></p></main>${script}<script>
const el=id=>document.getElementById(id);async function request(url,body){const r=await fetch(url,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error);return data;}async function refresh(){try{const d=await request('/me');el('login').classList.add('hidden');for(const id of ['tasks','logout','user'])el(id).classList.remove('hidden');el('user').textContent=d.user;el('list').replaceChildren();for(const t of d.tasks){const li=document.createElement('li');li.textContent=(t.done?'✓ ':'○ ')+t.title;el('list').append(li);}el('setup').classList.toggle('hidden',d.configured);}catch{el('login').classList.remove('hidden');for(const id of ['tasks','logout','user'])el(id).classList.add('hidden');}}for(const b of document.querySelectorAll('[data-user]'))b.onclick=async()=>{try{await request('/login',{user:b.dataset.user});location.reload();}catch(e){el('error').textContent=e.message;}};el('logout').onclick=async()=>{window.OrchestratorWidget?.logout();await request('/logout',{});location.reload();};el('refresh').onclick=refresh;window.addEventListener('orchestrator:action-completed',event=>{if(event.detail?.deploymentId===${JSON.stringify(validDeploymentId(deploymentId) ? deploymentId : '')}){void refresh();}});el('test-token').onclick=async()=>{const t=await request('/demo/token',{});el('token').classList.remove('hidden');el('token').textContent='Token: '+t.apiToken+'\\nExpires: '+t.expiresAt;};refresh();
</script></body></html>`;
}
