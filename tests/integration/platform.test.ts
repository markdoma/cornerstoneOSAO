import '../env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createApp, cleanup } from '../../apps/api/src/server.js';
import { createHost, sampleSpecification } from '../../apps/sample-host/src/server.js';
import { db } from '../../apps/api/src/db.js';
import type { ModelStep } from '../../apps/api/src/runtime.js';
import { hash, encrypt } from '../../apps/api/src/crypto.js';
const origin = 'http://localhost:3000',
  hostOrigin = 'http://localhost:3002';
let mode = 'normal';
let targetTaskId = '';
const model: ModelStep = async ({ input, emit }) => {
  if (mode === 'outside')
    return {
      id: randomUUID(),
      text: '',
      calls: [{ id: randomUUID(), name: 'unauthorized_tool', arguments: '{}' }],
      inputTokens: 1,
      outputTokens: 1,
    };
  if (mode === 'loop')
    return {
      id: randomUUID(),
      text: '',
      calls: [{ id: randomUUID(), name: 'list_tasks', arguments: '{}' }],
      inputTokens: 1,
      outputTokens: 1,
    };
  if (mode === 'invalid')
    return {
      id: randomUUID(),
      text: '',
      calls: [
        {
          id: randomUUID(),
          name: 'create_task',
          arguments: JSON.stringify({ body: { title: 123 } }),
        },
      ],
      inputTokens: 1,
      outputTokens: 1,
    };
  const first = input.at(-1);
  if (first.type === 'function_call_output') {
    if (mode === 'followup-error') throw new Error('AI follow-up failed');
    emit('delta', { text: 'Action completed.' });
    return {
      id: randomUUID(),
      text: 'Action completed.',
      calls: [],
      inputTokens: 5,
      outputTokens: 3,
    };
  }
  if (['get', 'update', 'delete'].includes(mode))
    return {
      id: randomUUID(),
      text: '',
      calls: [
        {
          id: randomUUID(),
          name: `${mode}_task`,
          arguments: JSON.stringify({
            path: { id: targetTaskId },
            ...(mode === 'update'
              ? { body: { title: 'Updated through approved CRUD', done: true } }
              : {}),
          }),
        },
      ],
      inputTokens: 5,
      outputTokens: 3,
    };
  const create = first.content.includes('create');
  return {
    id: randomUUID(),
    text: '',
    calls: [
      {
        id: randomUUID(),
        name: create ? 'create_task' : 'list_tasks',
        arguments: JSON.stringify(create ? { body: { title: 'Created with approval' } } : {}),
      },
    ],
    inputTokens: 8,
    outputTokens: 4,
  };
};
function event(body: string, name: string) {
  const part = body.split('\n\n').find((p) => p.startsWith(`event: ${name}\n`));
  return part ? JSON.parse(part.split('\ndata: ')[1]) : null;
}
test(
  'authenticated platform and sample host CRUD boundaries',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const app = await createApp({ model });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address() as any;
    const orgIds: string[] = [];
    let host: Awaited<ReturnType<typeof createHost>> | undefined;
    const request = async (path: string, body?: any, cookie?: string, method?: string) =>
      app.inject({
        method: (method ?? (body === undefined ? 'GET' : 'POST')) as any,
        url: path,
        headers: { origin, ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { payload: body }),
      });
    try {
      const register = async (suffix: string) => {
        const r = await request('/v1/auth/signup', {
          name: suffix,
          organization: suffix,
          email: `${randomUUID()}@test.example`,
          password: 'safe-password-123',
        });
        assert.equal(r.statusCode, 200, r.body);
        const cookie = String(r.headers['set-cookie']).split(';')[0];
        const me = (await request('/v1/auth/me', undefined, cookie)).json();
        orgIds.push(me.orgId);
        return { cookie, me };
      };
      const alice = await register('First org'),
        other = await register('Other org');
      let connection: any,
        tools: any[],
        agent: any,
        version: any,
        deployment: any,
        widgetToken = '',
        conversationId = '',
        hostCookie = '';
      const widgetHeaders = () => ({
        authorization: `Bearer ${widgetToken}`,
        'x-host-origin': hostOrigin,
        origin: 'http://localhost:4000',
      });
      await t.test('dashboard authentication and origin checks', async () => {
        assert.equal((await request('/v1/agents')).statusCode, 401);
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/connections',
              headers: { cookie: alice.cookie, origin: 'https://evil.example' },
              payload: {},
            })
          ).statusCode,
          403,
        );
      });
      await t.test('owner setup, reviewed import, and immutable publishing', async () => {
        let r = await request(
          '/v1/connections',
          { name: 'Sample', baseUrl: 'http://127.0.0.1:3002/api' },
          alice.cookie,
        );
        assert.equal(r.statusCode, 200, r.body);
        connection = r.json();
        r = await request(
          '/v1/tools/import',
          { spec: JSON.stringify(sampleSpecification(hostOrigin)) },
          alice.cookie,
        );
        assert.equal(r.statusCode, 200, r.body);
        tools = [];
        for (const definition of r.json().tools) {
          const created = await request(
            '/v1/tools',
            { connectionId: connection.id, definition, enabled: false },
            alice.cookie,
          );
          assert.equal(created.statusCode, 200, created.body);
          const tool = created.json();
          tools.push(tool);
          await request(`/v1/tools/${tool.id}`, { enabled: true }, alice.cookie, 'PATCH');
        }
        r = await request(
          '/v1/agents',
          {
            name: 'Tasks assistant',
            description: 'Manages tasks',
            prompt: 'Help with tasks',
            model: 'test-model',
            toolIds: tools.map((x) => x.id),
          },
          alice.cookie,
        );
        assert.equal(r.statusCode, 200, r.body);
        agent = r.json();
        r = await request(`/v1/agents/${agent.id}/publish`, {}, alice.cookie);
        assert.equal(r.statusCode, 200, r.body);
        version = r.json();
        await request(
          `/v1/agents/${agent.id}`,
          { ...agent.draft, name: 'Changed draft' },
          alice.cookie,
          'PATCH',
        );
        assert.equal(
          ((await db.agentVersion.findUniqueOrThrow({ where: { id: version.id } })).config as any)
            .name,
          'Tasks assistant',
        );
        r = await request(
          '/v1/deployments',
          {
            name: 'Sample deployment',
            versionId: version.id,
            origins: [hostOrigin],
            theme: { template: 'inline' },
          },
          alice.cookie,
        );
        assert.equal(r.statusCode, 200, r.body);
        deployment = r.json();
        assert.ok(deployment.integrationKey);
        assert.equal(
          (await request('/v1/deployments', undefined, alice.cookie)).json()[0].keyHash,
          undefined,
        );
      });
      await t.test('organization boundaries and forged version references', async () => {
        const contract = await request(
          `/v1/deployments/${deployment.id}/integration`,
          undefined,
          alice.cookie,
        );
        assert.equal(contract.statusCode, 200);
        assert.deepEqual(new Set(contract.json().toolIds), new Set(tools.map((t) => t.id)));
        assert.equal(
          (await request(`/v1/deployments/${deployment.id}/integration`, undefined, other.cookie))
            .statusCode,
          404,
        );
        assert.equal(
          (await request(`/v1/agents/${agent.id}`, agent.draft, other.cookie, 'PATCH')).statusCode,
          404,
        );
        assert.equal((await request('/v1/agents', agent.draft, other.cookie)).statusCode, 400);
        assert.equal(
          (
            await request(
              '/v1/deployments',
              { name: 'Bad', versionId: version.id, origins: [hostOrigin], theme: {} },
              other.cookie,
            )
          ).statusCode,
          404,
        );
        assert.equal((await request('/v1/tools', undefined, other.cookie)).json().length, 0);
      });
      await t.test('host login and server-to-server session exchange', async () => {
        host = await createHost({
          apiUrl: `http://127.0.0.1:${address.port}`,
          widgetOrigin: 'http://localhost:4000',
          origin: hostOrigin,
          integrationKey: deployment.integrationKey,
          deploymentId: deployment.id,
          toolIds: [],
        });
        await host.listen({ host: '127.0.0.1', port: 3002 });
        assert.equal(
          (
            await host.inject({
              method: 'POST',
              url: '/assistant/session',
              headers: { origin: hostOrigin },
              payload: {},
            })
          ).statusCode,
          401,
        );
        const login = await host.inject({
          method: 'POST',
          url: '/login',
          headers: { origin: hostOrigin },
          payload: { user: 'alice' },
        });
        hostCookie = String(login.headers['set-cookie']).split(';')[0];
        const exchanged = await host.inject({
          method: 'POST',
          url: '/assistant/session',
          headers: { origin: hostOrigin, cookie: hostCookie },
          payload: { userId: 'bob' },
        });
        assert.equal(exchanged.statusCode, 200, exchanged.body);
        widgetToken = exchanged.json().token;
        const stored = await db.widgetSession.findUniqueOrThrow({
          where: { tokenHash: hash(widgetToken) },
        });
        assert.equal(stored.userId, 'alice');
        assert.deepEqual(new Set(stored.toolIds), new Set(tools.map((t) => t.id)));
        assert.ok(stored.credential);
        assert.ok(!stored.credential!.includes(widgetToken));
        const r = await app.inject({
          method: 'POST',
          url: '/v1/widget/conversations',
          headers: widgetHeaders(),
          payload: {},
        });
        assert.equal(r.statusCode, 200, r.body);
        conversationId = r.json().id;
      });
      await t.test(
        'unauthorized origins, invalid bearer tokens, and scope escalation',
        async () => {
          assert.equal(
            (
              await app.inject({
                url: '/v1/widget/config',
                headers: { ...widgetHeaders(), 'x-host-origin': 'https://evil.example' },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await app.inject({
                url: '/v1/widget/config',
                headers: { ...widgetHeaders(), authorization: 'Bearer forged' },
              })
            ).statusCode,
            401,
          );
          const bad = await app.inject({
            method: 'POST',
            url: '/v1/widget-sessions',
            headers: { authorization: `Bearer ${deployment.integrationKey}` },
            payload: {
              deploymentId: deployment.id,
              userId: 'alice',
              origin: hostOrigin,
              toolIds: ['forged-tool'],
              apiToken: 'test',
              apiTokenExpiresAt: new Date(Date.now() + 300000).toISOString(),
            },
          });
          assert.equal(bad.statusCode, 403);
        },
      );
      await t.test(
        'automatic tool policy is explicit and cannot mix with a custom subset',
        async () => {
          const payload = {
            deploymentId: deployment.id,
            userId: 'alice',
            origin: hostOrigin,
            apiToken: 'test-user-token',
            apiTokenExpiresAt: new Date(Date.now() + 300000).toISOString(),
          };
          const exchange = (policy: any) =>
            app.inject({
              method: 'POST',
              url: '/v1/widget-sessions',
              headers: { authorization: `Bearer ${deployment.integrationKey}` },
              payload: { ...payload, ...policy },
            });
          assert.equal((await exchange({})).statusCode, 400);
          assert.equal((await exchange({ toolIds: [], useDeploymentTools: true })).statusCode, 400);
          const r = await exchange({ useDeploymentTools: true });
          assert.equal(r.statusCode, 200, r.body);
          const session = await db.widgetSession.findUniqueOrThrow({
            where: { tokenHash: hash(r.json().token) },
          });
          assert.deepEqual(new Set(session.toolIds), new Set(tools.map((t) => t.id)));
          const disabledId = tools[0].id;
          await db.tool.update({ where: { id: disabledId }, data: { enabled: false } });
          try {
            const filtered = await exchange({ useDeploymentTools: true });
            assert.equal(filtered.statusCode, 200, filtered.body);
            const filteredSession = await db.widgetSession.findUniqueOrThrow({
              where: { tokenHash: hash(filtered.json().token) },
            });
            assert.ok(!filteredSession.toolIds.includes(disabledId));
            assert.equal((await exchange({ toolIds: [disabledId] })).statusCode, 403);
          } finally {
            await db.tool.update({ where: { id: disabledId }, data: { enabled: true } });
          }

          const empty = await exchange({ toolIds: [] });
          assert.equal(empty.statusCode, 200, empty.body);
          assert.deepEqual(
            (
              await db.widgetSession.findUniqueOrThrow({
                where: { tokenHash: hash(empty.json().token) },
              })
            ).toolIds,
            [],
          );
        },
      );
      await t.test('read tool returns only the host user’s tasks', async () => {
        const r = await app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conversationId}/messages`,
          headers: widgetHeaders(),
          payload: { text: 'list tasks' },
        });
        assert.ok(event(r.body, 'done'), r.body);
        assert.equal(event(r.body, 'error'), null, r.body);
        assert.equal(
          await db.auditEvent.count({ where: { conversationId, status: 'SUCCEEDED' } }),
          1,
        );
      });
      let action: any;
      await t.test('writes pause before execution and reject changed arguments', async () => {
        const before = (await host!.inject({ url: '/me', headers: { cookie: hostCookie } })).json()
          .tasks.length;
        const r = await app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conversationId}/messages`,
          headers: widgetHeaders(),
          payload: { text: 'create a task' },
        });
        action = event(r.body, 'approval');
        assert.ok(action, r.body);
        assert.equal(
          (await host!.inject({ url: '/me', headers: { cookie: hostCookie } })).json().tasks.length,
          before,
        );
        const modified = await app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conversationId}/approve`,
          headers: widgetHeaders(),
          payload: { id: action.id, approved: true, arguments: { title: 'tampered' } },
        });
        assert.equal(modified.statusCode, 400);
      });
      await t.test(
        'approval executes once; repeated confirmation cannot replay writes',
        async () => {
          const path = `/v1/widget/conversations/${conversationId}/approve`,
            payload = { id: action.id, approved: true };
          const first = await app.inject({
            method: 'POST',
            url: path,
            headers: widgetHeaders(),
            payload,
          });
          assert.equal(event(first.body, 'error'), null, first.body);
          assert.ok(event(first.body, 'done'));
          assert.deepEqual(event(first.body, 'action_completed'), {
            actionId: action.id,
            toolId: tools.find((t) => t.definition.name === 'create_task').id,
          });
          const replay = await app.inject({
            method: 'POST',
            url: path,
            headers: widgetHeaders(),
            payload,
          });
          assert.equal(event(replay.body, 'error').status, 409);
          assert.equal(event(replay.body, 'action_completed'), null);
          const tasks = (await host!.inject({ url: '/me', headers: { cookie: hostCookie } })).json()
            .tasks;
          assert.equal(tasks.filter((x: any) => x.title === 'Created with approval').length, 1);
        },
      );
      await t.test(
        'read, update, and delete operate on the same host records after approval',
        async () => {
          const tasks = (await host!.inject({ url: '/me', headers: { cookie: hostCookie } })).json()
            .tasks;
          targetTaskId = tasks.find((t: any) => t.title === 'Created with approval').id;
          const turn = () =>
            app.inject({
              method: 'POST',
              url: `/v1/widget/conversations/${conversationId}/messages`,
              headers: widgetHeaders(),
              payload: { text: 'Operate on my task' },
            });
          const snapshot = async () =>
            (await host!.inject({ url: '/me', headers: { cookie: hostCookie } })).json().tasks;
          try {
            mode = 'get';
            const read = await turn();
            assert.equal(event(read.body, 'error'), null, read.body);
            assert.equal(event(read.body, 'action_completed'), null);
            for (const operation of ['update', 'delete']) {
              mode = operation;
              const proposed = await turn();
              const pending = event(proposed.body, 'approval');
              assert.ok(pending, proposed.body);
              assert.ok((await snapshot()).some((t: any) => t.id === targetTaskId));
              const result = await app.inject({
                method: 'POST',
                url: `/v1/widget/conversations/${conversationId}/approve`,
                headers: widgetHeaders(),
                payload: { id: pending.id, approved: true },
              });
              assert.equal(event(result.body, 'error'), null, result.body);
              assert.equal(event(result.body, 'action_completed').actionId, pending.id);
              const after = await snapshot();
              if (operation === 'update') {
                const task = after.find((t: any) => t.id === targetTaskId);
                assert.equal(task.title, 'Updated through approved CRUD');
                assert.equal(task.done, true);
              } else assert.ok(!after.some((t: any) => t.id === targetTaskId));
            }
          } finally {
            mode = 'normal';
          }
        },
      );
      await t.test(
        'successful API writes notify the host even if the model follow-up fails',
        async () => {
          mode = 'followup-error';
          try {
            const proposed = await app.inject({
              method: 'POST',
              url: `/v1/widget/conversations/${conversationId}/messages`,
              headers: widgetHeaders(),
              payload: { text: 'create a task' },
            });
            const pending = event(proposed.body, 'approval');
            assert.ok(pending, proposed.body);
            const completed = await app.inject({
              method: 'POST',
              url: `/v1/widget/conversations/${conversationId}/approve`,
              headers: widgetHeaders(),
              payload: { id: pending.id, approved: true },
            });
            assert.equal(event(completed.body, 'action_completed').actionId, pending.id);
            assert.ok(event(completed.body, 'error'));
            const saved = await db.pendingAction.findUniqueOrThrow({ where: { id: pending.id } });
            assert.equal(saved.status, 'SUCCEEDED');
          } finally {
            mode = 'normal';
          }
        },
      );
      await t.test('rejection prevents execution', async () => {
        const before = await db.auditEvent.count({ where: { conversationId } });
        const proposed = await app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conversationId}/messages`,
          headers: widgetHeaders(),
          payload: { text: 'create another' },
        });
        const a = event(proposed.body, 'approval');
        assert.ok(a, proposed.body);
        const result = await app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conversationId}/approve`,
          headers: widgetHeaders(),
          payload: { id: a.id, approved: false },
        });
        assert.equal(event(result.body, 'error'), null, result.body);
        assert.equal(event(result.body, 'action_completed'), null);
        assert.equal(await db.auditEvent.count({ where: { conversationId } }), before);
      });
      await t.test('cross-user conversations and sample record ownership', async () => {
        const r = await host!.inject({
          method: 'POST',
          url: '/login',
          headers: { origin: hostOrigin },
          payload: { user: 'bob' },
        });
        const cookie = String(r.headers['set-cookie']).split(';')[0];
        const ws = (
          await host!.inject({
            method: 'POST',
            url: '/assistant/session',
            headers: { origin: hostOrigin, cookie },
            payload: {},
          })
        ).json();
        assert.equal(
          (
            await app.inject({
              url: `/v1/widget/conversations/${conversationId}`,
              headers: { ...widgetHeaders(), authorization: `Bearer ${ws.token}` },
            })
          ).statusCode,
          404,
        );
        const bearer = (
          await host!.inject({
            method: 'POST',
            url: '/demo/token',
            headers: { origin: hostOrigin, cookie },
            payload: {},
          })
        ).json().apiToken;
        const aliceTask = (
          await host!.inject({ url: '/me', headers: { cookie: hostCookie } })
        ).json().tasks[0];
        assert.equal(
          (
            await host!.inject({
              url: `/api/tasks/${aliceTask.id}`,
              headers: { authorization: `Bearer ${bearer}` },
            })
          ).statusCode,
          404,
        );
      });
      await t.test('out-of-scope model calls, invalid arguments, and bounded loops', async () => {
        const send = () =>
          app.inject({
            method: 'POST',
            url: `/v1/widget/conversations/${conversationId}/messages`,
            headers: widgetHeaders(),
            payload: { text: 'test guardrails' },
          });
        mode = 'outside';
        let r = await send();
        assert.equal(event(r.body, 'error').status, 403);
        mode = 'invalid';
        r = await send();
        assert.ok(event(r.body, 'error'));
        assert.equal(
          await db.pendingAction.count({
            where: { conversationId, status: 'PENDING', expiresAt: { gt: new Date() } },
          }),
          0,
        );
        mode = 'loop';
        const before = await db.auditEvent.count({ where: { conversationId } });
        r = await send();
        assert.match(event(r.body, 'error').message, /limit/);
        assert.equal((await db.auditEvent.count({ where: { conversationId } })) - before, 10);
        mode = 'normal';
      });
      await t.test('approval rechecks disabled tools and expires without execution', async () => {
        let r = await app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conversationId}/messages`,
          headers: widgetHeaders(),
          payload: { text: 'create guarded task' },
        });
        const a = event(r.body, 'approval');
        assert.ok(a, r.body);
        const create = tools.find((t) => t.definition.name === 'create_task');
        await db.tool.update({ where: { id: create.id }, data: { enabled: false } });
        const before = await db.auditEvent.count({ where: { conversationId } });
        r = await app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conversationId}/approve`,
          headers: widgetHeaders(),
          payload: { id: a.id, approved: true },
        });
        assert.equal(event(r.body, 'error').status, 403);
        assert.equal(await db.auditEvent.count({ where: { conversationId } }), before);
        await db.tool.update({ where: { id: create.id }, data: { enabled: true } });
        await db.pendingAction.update({
          where: { id: a.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
        r = await app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conversationId}/approve`,
          headers: widgetHeaders(),
          payload: { id: a.id, approved: true },
        });
        assert.equal(event(r.body, 'error').status, 409);
      });
      await t.test(
        'password reset tokens are single-use and revoke dashboard sessions',
        async () => {
          let delivered = '';
          const smtp = createServer((socket) => {
            socket.write('220 localhost ESMTP\r\n');
            let buffer = '',
              dataMode = false;
            socket.on('data', (chunk) => {
              buffer += chunk.toString();
              let end: number;
              while ((end = buffer.indexOf('\r\n')) >= 0) {
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (dataMode) {
                  if (line === '.') {
                    dataMode = false;
                    socket.write('250 Message accepted\r\n');
                  } else delivered += line + '\r\n';
                } else if (line.startsWith('DATA')) {
                  dataMode = true;
                  socket.write('354 End data with dot\r\n');
                } else if (line.startsWith('QUIT')) socket.end('221 Bye\r\n');
                else socket.write('250 OK\r\n');
              }
            });
          });
          smtp.listen(1026, '127.0.0.1');
          await once(smtp, 'listening');
          try {
            const sent = await request('/v1/auth/forgot', { email: other.me.user.email });
            assert.equal(sent.statusCode, 200, sent.body);
          } finally {
            smtp.close();
          }
          const raw = delivered
            .replace(/=\r\n/g, '')
            .replaceAll('=3D', '=')
            .match(/reset=([a-zA-Z0-9_-]+)/)?.[1];
          assert.ok(raw, 'SMTP message contains reset token');
          const result = await request('/v1/auth/reset', {
            token: raw,
            password: 'new-safe-password-123',
          });
          assert.equal(result.statusCode, 200, result.body);
          assert.equal((await request('/v1/agents', undefined, other.cookie)).statusCode, 401);
          assert.equal(
            (await request('/v1/auth/reset', { token: raw, password: 'new-safe-password-456' }))
              .statusCode,
            400,
          );
          assert.equal(
            (
              await request('/v1/auth/login', {
                email: other.me.user.email,
                password: 'new-safe-password-123',
              })
            ).statusCode,
            200,
          );
        },
      );
      await t.test('expiry, host logout, and credential cleanup', async () => {
        const s = await db.widgetSession.findUniqueOrThrow({
          where: { tokenHash: hash(widgetToken) },
        });
        await db.widgetSession.update({
          where: { id: s.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
        assert.equal(
          (await app.inject({ url: '/v1/widget/config', headers: widgetHeaders() })).statusCode,
          401,
        );
        await cleanup();
        assert.equal(
          (await db.widgetSession.findUniqueOrThrow({ where: { id: s.id } })).credential,
          null,
        );
        const renewed = await host!.inject({
          method: 'POST',
          url: '/assistant/session',
          headers: { origin: hostOrigin, cookie: hostCookie },
          payload: {},
        });
        widgetToken = renewed.json().token;
        await host!.inject({
          method: 'POST',
          url: '/logout',
          headers: { origin: hostOrigin, cookie: hostCookie },
          payload: {},
        });
        assert.equal(
          (await app.inject({ url: '/v1/widget/config', headers: widgetHeaders() })).statusCode,
          401,
        );
        const revoked = await db.widgetSession.findUniqueOrThrow({
          where: { tokenHash: hash(widgetToken) },
        });
        assert.equal(revoked.credential, null);
      });
    } finally {
      await host?.close();
      await app.close();
      const convs = await db.conversation.findMany({
        where: { orgId: { in: orgIds } },
        select: { id: true },
      });
      await db.message.deleteMany({ where: { conversationId: { in: convs.map((c) => c.id) } } });
      for (const model of [
        'usage',
        'auditEvent',
        'pendingAction',
        'conversation',
        'widgetSession',
        'deployment',
        'agentVersion',
        'agent',
        'tool',
        'connection',
        'dashboardSession',
        'membership',
      ] as const)
        await (db[model] as any).deleteMany({ where: { orgId: { in: orgIds } } });
      await db.organization.deleteMany({ where: { id: { in: orgIds } } });
      await db.$disconnect();
    }
  },
);
