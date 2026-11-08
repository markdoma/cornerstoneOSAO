import './env.js';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeServer } from '../apps/bridge/src/server.js';
import { createHost, sampleSpecification } from '../apps/sample-host/src/server.js';
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
const dir = await mkdtemp(join(tmpdir(), 'ao-mcp-browser-'));
const keys = generateKeyPairSync('ed25519');
await writeFile(dir + '/private.pem', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  mode: 0o600,
});
await writeFile(dir + '/public.pem', keys.publicKey.export({ type: 'spki', format: 'pem' }));
Object.assign(process.env, {
  MCP_BRIDGE_ENABLED: 'true',
  LEGACY_DIRECT_SETUP_ENABLED: 'false',
  BRIDGE_PRIVATE_KEY_PATH: dir + '/private.pem',
  BRIDGE_URL: 'http://127.0.0.1:4110',
  WEB_ORIGIN: 'http://localhost:3100',
  WIDGET_ORIGIN: 'http://localhost:4100',
  ALLOW_LOCAL_DEMO_API: 'http://127.0.0.1:3102/api',
});
const bridge = await createBridgeServer({
  databaseUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379',
  encryptionKey: 'c'.repeat(64),
  publicKeyPath: dir + '/public.pem',
});
await bridge.listen({ host: '127.0.0.1', port: 4110 });
const { createApp } = await import('../apps/api/src/server.js');
const { db } = await import('../apps/api/src/db.js');
const model: any = async ({ input, emit }: any) => {
  if (input.at(-1).type === 'function_call_output') {
    emit('delta', { text: 'Your MCP request is complete.' });
    return {
      id: randomUUID(),
      text: 'Your MCP request is complete.',
      calls: [],
      inputTokens: 1,
      outputTokens: 1,
    };
  }
  return {
    id: randomUUID(),
    text: '',
    calls: [
      {
        id: randomUUID(),
        name: 'create_task',
        arguments: JSON.stringify({ body: { title: 'Browser MCP task' } }),
      },
    ],
    inputTokens: 1,
    outputTokens: 1,
  };
};
const app = await createApp({ model, testRateLimitMax: 1000 });
const tenantId = `browser-${randomUUID()}`;
const email = `mcp-browser-${randomUUID()}@example.test`,
  password = 'Browser-password-123';
let me: any;
app.get('/test/fixture', async () => ({
  email,
  password,
  orgId: me.orgId,
  tenantId,
  spec: sampleSpecification('http://localhost:3102'),
}));
const options = {
  apiUrl: 'http://127.0.0.1:4100',
  widgetOrigin: 'http://localhost:4100',
  origin: 'http://localhost:3102',
  integrationKey: '',
  deploymentId: '',
  toolIds: [] as string[],
  tenantId,
};
let host = await createHost(options);
await host.listen({ host: '127.0.0.1', port: 3102 });
app.post('/test/connect', async (req) => {
  const body = req.body as any;
  const dep = await db.deployment.findFirst({ where: { id: body.deploymentId, orgId: me.orgId } });
  if (!dep) throw Error('Test deployment not found');
  const version = await db.agentVersion.findUniqueOrThrow({ where: { id: dep.versionId } });
  await host.close();
  host = await createHost({
    ...options,
    deploymentId: dep.id,
    sessionEndpoint: (version.config as any).hostSessionEndpoint ?? '/assistant/session',
    integrationKey: body.integrationKey,
  });
  await host.listen({ host: '127.0.0.1', port: 3102 });
  return { ok: true };
});
const r = await app.inject({
  method: 'POST',
  url: '/v1/auth/signup',
  headers: { origin: process.env.WEB_ORIGIN },
  payload: { name: 'MCP Owner', email, password, organization: 'MCP Browser Tests' },
});
if (r.statusCode !== 200) throw new Error(r.body);
const cookie = String(r.headers['set-cookie']).split(';')[0];
me = (
  await app.inject({ url: '/v1/auth/me', headers: { cookie, origin: process.env.WEB_ORIGIN } })
).json();
await app.listen({ host: '127.0.0.1', port: 4100 });
console.log('Isolated MCP browser fixture ready');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await host.close();
    await app.close();
    await bridge.close();
    const conv = await db.conversation.findMany({
      where: { orgId: me.orgId },
      select: { id: true },
    });
    await db.message.deleteMany({ where: { conversationId: { in: conv.map((c) => c.id) } } });
    for (const table of [
      'bridgeExecution',
      'bridgeRevision',
      'bridge',
      'bridgeTenant',
      'pendingAction',
      'usage',
      'auditEvent',
      'conversation',
      'widgetSession',
      'deployment',
      'agentVersion',
      'agent',
      'tool',
      'connection',
      'membership',
      'organization',
    ] as const)
      await (db[table] as any).deleteMany({
        where: table === 'organization' ? { id: me.orgId } : { orgId: me.orgId },
      });
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
    process.exit(0);
  });
