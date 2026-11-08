import './env.js';
import { randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/server.js';
import { createHost, sampleSpecification } from '../apps/sample-host/src/server.js';
import type { ModelStep } from '../apps/api/src/runtime.js';
import { db } from '../apps/api/src/db.js';
if (!process.env.TEST_DATABASE_URL)
  throw new Error('TEST_DATABASE_URL is required for browser tests');
const model: ModelStep = async ({ input, emit }) => {
  const first = input.at(-1);
  if (first.type === 'function_call_output') {
    const text = 'Your request is complete.';
    emit('delta', { text });
    return { id: randomUUID(), text, calls: [], inputTokens: 10, outputTokens: 4 };
  }
  const write = first.content.toLowerCase().includes('create');
  return {
    id: randomUUID(),
    text: '',
    calls: [
      {
        id: randomUUID(),
        name: write ? 'create_task' : 'list_tasks',
        arguments: JSON.stringify(write ? { body: { title: 'Browser-approved task' } } : {}),
      },
    ],
    inputTokens: 8,
    outputTokens: 5,
  };
};
const app = await createApp({ model });
let fixture: Record<string, string> = {};
app.get('/test/fixture', async () => fixture);
const origin = 'http://localhost:3100',
  email = `browser-${process.pid}@relay.test`,
  password = 'Browser-password-123';
const signup = await app.inject({
  method: 'POST',
  url: '/v1/auth/signup',
  headers: { origin },
  payload: { email, password, name: 'Alex Morgan', organization: 'Acme Studio' },
});
if (signup.statusCode !== 200) throw new Error(signup.body);
const cookie = String(signup.headers['set-cookie']).split(';')[0];
async function post(url: string, payload: any) {
  const r = await app.inject({ method: 'POST', url, headers: { origin, cookie }, payload });
  if (r.statusCode !== 200) throw new Error(r.body);
  return r.json();
}
const connection = await post('/v1/connections', {
  name: 'Taskboard API',
  baseUrl: 'http://127.0.0.1:3102/api',
});
const imported = await post('/v1/tools/import', {
  spec: JSON.stringify(sampleSpecification('http://localhost:3102')),
});
const toolIds: string[] = [];
for (const definition of imported.tools) {
  const t = await post('/v1/tools', { connectionId: connection.id, definition, enabled: true });
  toolIds.push(t.id);
}
const agent = await post('/v1/agents', {
  name: 'Task assistant',
  description: 'Your helpful teammate for managing everyday tasks.',
  prompt: 'Help the user manage their tasks.',
  welcome: 'Hi there! What can I help you get done today?',
  starters: ['Show my tasks', 'Create a task'],
  model: 'test-model',
  toolIds,
});
const version = await post(`/v1/agents/${agent.id}/publish`, {});
const deployment = await post('/v1/deployments', {
  name: 'Taskboard assistant',
  versionId: version.id,
  origins: ['http://localhost:3102'],
  theme: { template: 'floating', title: 'Task assistant' },
});
fixture = { email, password, deploymentId: deployment.id, agentId: agent.id };
await app.listen({ host: '127.0.0.1', port: 4100 });
const host = await createHost({
  apiUrl: 'http://127.0.0.1:4100',
  widgetOrigin: 'http://localhost:4100',
  origin: 'http://localhost:3102',
  integrationKey: deployment.integrationKey,
  deploymentId: deployment.id,
  toolIds,
});
await host.listen({ host: '127.0.0.1', port: 3102 });
console.log('Browser test fixture ready on 4100 and 3102 (mock model, isolated test database).');
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => {
    await host.close();
    await app.close();
    await db.$disconnect();
    process.exit(0);
  });
