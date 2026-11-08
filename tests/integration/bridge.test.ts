import '../env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridgeServer } from '../../apps/bridge/src/server.js';
import { createHost, sampleSpecification } from '../../apps/sample-host/src/server.js';
import { importOpenAPI } from '@orchestrator/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SignJWT, importPKCS8 } from 'jose';
import { createClient } from 'redis';

test(
  'managed MCP bridge authenticates host users and executes existing APIs',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'ao-bridge-test-'));
    const keys = generateKeyPairSync('ed25519');
    const privatePath = join(dir, 'private.pem'),
      publicPath = join(dir, 'public.pem');
    await writeFile(privatePath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    await writeFile(publicPath, keys.publicKey.export({ type: 'spki', format: 'pem' }));
    process.env.MCP_BRIDGE_ENABLED = 'true';
    process.env.BRIDGE_PRIVATE_KEY_PATH = privatePath;
    const bridge = await createBridgeServer({
      databaseUrl: process.env.DATABASE_URL!,
      redisUrl: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379',
      encryptionKey: 'b'.repeat(64),
      publicKeyPath: publicPath,
    });
    await bridge.listen({ host: '127.0.0.1', port: 0 });
    process.env.BRIDGE_URL = `http://127.0.0.1:${(bridge.server.address() as any).port}`;
    const origin = 'http://localhost:3000',
      hostOrigin = 'http://localhost:3002';
    let host: any;
    // Reserve the test host API address before importing AO's fixed destination policy.
    const bootstrap = await createHost({
      apiUrl: 'http://localhost:4000',
      widgetOrigin: 'http://localhost:4000',
      origin: hostOrigin,
      integrationKey: '',
      deploymentId: '',
      toolIds: [],
    });
    await bootstrap.listen({ host: '127.0.0.1', port: 0 });
    const port = (bootstrap.server.address() as any).port;
    await bootstrap.close();
    const base = `http://127.0.0.1:${port}/api`;
    process.env.ALLOW_LOCAL_DEMO_API = base;
    const { createApp } = await import('../../apps/api/src/server.js');
    const { db } = await import('../../apps/api/src/db.js');
    const { bridgeSigner } = await import('../../packages/bridge/src/auth.js');
    const { sessionGrant, callBridgeTool, discoverBridgeTools } =
      await import('../../apps/api/src/bridge-client.js');
    let op = 'create_task';
    let taskId = '';
    let executedAction = '';
    let slowCalls = 0;
    const model: any = async ({ input }: any) =>
      input.at(-1).type === 'function_call_output'
        ? { id: randomUUID(), text: 'Completed', calls: [], inputTokens: 1, outputTokens: 1 }
        : {
            id: randomUUID(),
            text: '',
            calls: [
              {
                id: randomUUID(),
                name: op,
                arguments: JSON.stringify(
                  op === 'create_task'
                    ? { body: { title: 'Created through MCP' } }
                    : op === 'list_tasks'
                      ? {}
                      : op === 'get_task' || op === 'delete_task'
                        ? { path: { id: taskId } }
                        : {
                            path: { id: taskId },
                            body: { title: 'Updated through MCP', done: true },
                          },
                ),
              },
            ],
            inputTokens: 1,
            outputTokens: 1,
          };
    const app = await createApp({ model });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const apiUrl = `http://127.0.0.1:${(app.server.address() as any).port}`;
    let orgId = '';
    let otherOrg = '';
    const event = (body: string, name: string) => {
      const part = body.split('\n\n').find((p) => p.startsWith(`event: ${name}\n`));
      return part ? JSON.parse(part.split('\ndata: ')[1]) : null;
    };
    try {
      const signup = await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        headers: { origin },
        payload: {
          name: 'Bridge owner',
          email: `bridge-${randomUUID()}@example.test`,
          password: 'Bridge-password-123',
          organization: 'Bridge tenant',
        },
      });
      assert.equal(signup.statusCode, 200, signup.body);
      const cookie = String(signup.headers['set-cookie']).split(';')[0];
      orgId =
        signup.json().orgId ??
        (await app.inject({ url: '/v1/auth/me', headers: { origin, cookie } })).json().orgId;
      const request = async (url: string, payload?: unknown, method?: string) => {
        const r = await app.inject({
          method: (method ?? (payload === undefined ? 'GET' : 'POST')) as any,
          url,
          headers: { origin, cookie },
          payload: payload as any,
        });
        assert.equal(r.statusCode, 200, r.body);
        return r.json();
      };
      const definitions = importOpenAPI(JSON.stringify(sampleSpecification(hostOrigin)));
      definitions.push({
        name: 'slow_create',
        description: 'Test uncertain upstream completion',
        method: 'POST',
        path: '/slow-tasks',
        kind: 'write',
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      });
      const draft = {
        name: 'Taskboard MCP',
        baseUrl: base,
        origins: [hostOrigin],
        tenantId: 'mcp-tenant',
        operations: definitions.map((definition, i) => ({
          id: 'op-' + i,
          definition,
          enabled: true,
          bindings: [],
        })),
      };
      let created: any,
        published: any,
        dep: any,
        access: any,
        hostCookie = '',
        conv: any;
      await t.test(
        'owner publishes bridge and agent without changing existing API routes',
        async () => {
          created = await request('/v1/bridges', draft);
          published = await request(`/v1/bridges/${created.id}/publish`, {});
          const a = await request('/v1/agents', {
            name: 'MCP assistant',
            description: 'Tasks',
            prompt: 'Use approved tools',
            welcome: 'Hello',
            starters: [],
            model: 'test-model',
            toolIds: published.tools.map((t: any) => t.id),
          });
          const version = await request(`/v1/agents/${a.id}/publish`, {});
          dep = await request('/v1/deployments', {
            name: 'MCP host',
            versionId: version.id,
            origins: [hostOrigin],
            theme: { template: 'floating' },
          });
          assert.equal(dep.authMode, 'bridge-session');
          host = await createHost({
            apiUrl,
            widgetOrigin: 'http://localhost:4000',
            origin: hostOrigin,
            integrationKey: dep.integrationKey,
            deploymentId: dep.id,
            toolIds: [],
            tenantId: 'mcp-tenant',
          });
          host.post('/api/slow-tasks', async (req: any) => {
            if (!req.headers.authorization?.startsWith('Bearer '))
              throw new Error('API credential missing');
            slowCalls++;
            await new Promise((r) => setTimeout(r, 500));
            return { created: true };
          });
          await host.listen({ host: '127.0.0.1', port });
        },
      );
      const wh = () => ({
        authorization: `Bearer ${access.token}`,
        'x-host-origin': hostOrigin,
        'x-deployment-id': dep.id,
      });
      await t.test(
        'host connector registers encrypted ephemeral credential; database stores metadata only',
        async () => {
          const login = await host.inject({
            method: 'POST',
            url: '/login',
            headers: { origin: hostOrigin },
            payload: { user: 'alice' },
          });
          hostCookie = String(login.headers['set-cookie']).split(';')[0];
          const r = await host.inject({
            method: 'POST',
            url: '/assistant/session',
            headers: { cookie: hostCookie, origin: hostOrigin },
            payload: { deploymentId: dep.id, userId: 'bob', tenantId: 'attacker' },
          });
          assert.equal(r.statusCode, 200, r.body);
          access = r.json();
          assert.ok(access.token);
          const session = await db.widgetSession.findFirstOrThrow({ where: { orgId } });
          assert.equal(session.credential, null);
          assert.equal(session.userId, 'alice');
          assert.equal(session.tenantId, 'mcp-tenant');
          assert.ok(session.credentialHandle);
          const r2 = await app.inject({ url: '/v1/widget/bridge-tools', headers: wh() });
          assert.equal(r2.statusCode, 200, r2.body);
          assert.equal(r2.json().tools.length, 6);
          conv = (
            await app.inject({ method: 'POST', url: '/v1/widget/conversations', headers: wh() })
          ).json();
          assert.ok(conv.id);
        },
      );
      const turn = () =>
        app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conv.id}/messages`,
          headers: wh(),
          payload: { text: 'Use the API' },
        });
      const approve = (id: string, approved = true) =>
        app.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conv.id}/approve`,
          headers: wh(),
          payload: { id, approved },
        });
      await t.test(
        'MCP write waits for confirmation, executes once and changes existing host records',
        async () => {
          const before = (await host.inject({ url: '/me', headers: { cookie: hostCookie } })).json()
            .tasks.length;
          const proposed = await turn();
          const pending = event(proposed.body, 'approval');
          assert.ok(pending, proposed.body);
          assert.equal(
            (await host.inject({ url: '/me', headers: { cookie: hostCookie } })).json().tasks
              .length,
            before,
          );
          executedAction = pending.id;
          const confirmed = await approve(pending.id);
          assert.equal(event(confirmed.body, 'error'), null, confirmed.body);
          assert.ok(event(confirmed.body, 'action_completed'));
          taskId = (await host.inject({ url: '/me', headers: { cookie: hostCookie } }))
            .json()
            .tasks.find((x: any) => x.title === 'Created through MCP').id;
          assert.ok(taskId);
          assert.equal(
            (
              await db.bridgeExecution.findUniqueOrThrow({
                where: { orgId_executionId: { orgId, executionId: pending.id } },
              })
            ).status,
            'SUCCEEDED',
          );
          assert.equal(event((await approve(pending.id)).body, 'error').status, 409);
        },
      );
      await t.test(
        'read/update/delete all use real MCP against unchanged CRUD endpoints',
        async () => {
          for (op of ['list_tasks', 'get_task', 'update_task', 'delete_task']) {
            const r = await turn();
            assert.equal(event(r.body, 'error'), null, r.body);
            if (['update_task', 'delete_task'].includes(op)) {
              const pending = event(r.body, 'approval');
              assert.ok(pending, r.body);
              const result = await approve(pending.id);
              assert.equal(event(result.body, 'error'), null, result.body);
            } else assert.ok(event(r.body, 'done'));
          }
          assert.ok(
            !(await host.inject({ url: '/me', headers: { cookie: hostCookie } }))
              .json()
              .tasks.some((x: any) => x.id === taskId),
          );
        },
      );
      await t.test('rejection does not call API or create execution ledger entry', async () => {
        op = 'create_task';
        const proposed = await turn();
        const pending = event(proposed.body, 'approval');
        assert.ok(pending, proposed.body);
        await approve(pending.id, false);
        assert.equal(
          await db.bridgeExecution.count({ where: { orgId, executionId: pending.id } }),
          0,
        );
      });
      await t.test(
        'bridge rejects invalid audience, credentials, and direct unauthenticated MCP requests',
        async () => {
          const direct = await bridge.inject({
            method: 'POST',
            url: '/mcp',
            payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          });
          assert.equal(direct.statusCode, 401);
          const session = await db.widgetSession.findFirstOrThrow({
            where: { orgId, revokedAt: null },
          });
          const sign = await bridgeSigner(privatePath);
          const raw = await sign({
            ...sessionGrant(session, [published.revision.id]),
            userId: 'bob',
          });
          const r = await bridge.inject({
            method: 'POST',
            url: '/mcp',
            headers: { authorization: `Bearer ${raw}` },
            payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          });
          assert.equal(r.statusCode, 401);
        },
      );
      await t.test('direct MCP replay cannot repeat a claimed write', async () => {
        const session = await db.widgetSession.findFirstOrThrow({
          where: { orgId, revokedAt: null },
        });
        const version = await db.agentVersion.findUniqueOrThrow({ where: { id: dep.versionId } });
        const tool = (version.config as any).tools.find((t: any) => t.name === 'create_task');
        const before = (await host.inject({ url: '/me', headers: { cookie: hostCookie } })).json()
          .tasks.length;
        await assert.rejects(
          callBridgeTool(
            session,
            tool,
            { body: { title: 'Created through MCP' } },
            executedAction,
            AbortSignal.timeout(5000),
            conv.id,
          ),
          /not retried/,
        );
        assert.equal(
          (await host.inject({ url: '/me', headers: { cookie: hostCookie } })).json().tasks.length,
          before,
        );
      });
      await t.test(
        'abandoned writes remain unknown and cannot be automatically retried',
        async () => {
          const session = await db.widgetSession.findFirstOrThrow({
            where: { orgId, revokedAt: null },
          });
          const version = await db.agentVersion.findUniqueOrThrow({ where: { id: dep.versionId } });
          const tool = (version.config as any).tools.find((t: any) => t.name === 'slow_create');
          const controller = new AbortController(),
            executionId = randomUUID();
          const result = callBridgeTool(
            session,
            tool,
            {},
            executionId,
            controller.signal,
            conv.id,
          ).catch(() => null);
          for (let i = 0; i < 100 && slowCalls === 0; i++)
            await new Promise((r) => setTimeout(r, 10));
          assert.equal(slowCalls, 1);
          controller.abort();
          await result;
          for (let i = 0; i < 100; i++) {
            const row = await db.bridgeExecution.findUnique({
              where: { orgId_executionId: { orgId, executionId } },
            });
            if (row?.status === 'FAILED_OR_UNKNOWN') break;
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.equal(
            (
              await db.bridgeExecution.findUniqueOrThrow({
                where: { orgId_executionId: { orgId, executionId } },
              })
            ).status,
            'FAILED_OR_UNKNOWN',
          );
          await assert.rejects(
            callBridgeTool(session, tool, {}, executionId, AbortSignal.timeout(5000), conv.id),
          );
          assert.equal(slowCalls, 1);
        },
      );
      await t.test('wrong bridge audience and malformed MCP requests fail closed', async () => {
        const key = await importPKCS8(
          await (await import('node:fs/promises')).readFile(privatePath, 'utf8'),
          'EdDSA',
        );
        const raw = await new SignJWT({ purpose: 'mcp' })
          .setProtectedHeader({ alg: 'EdDSA', kid: 'ao-bridge-1', typ: 'JWT' })
          .setIssuer('cornerstonelabs-ao')
          .setAudience('application-api')
          .setIssuedAt()
          .setExpirationTime('60s')
          .setJti(randomUUID())
          .sign(key);
        assert.equal(
          (
            await bridge.inject({
              method: 'POST',
              url: '/mcp',
              headers: { authorization: `Bearer ${raw}` },
              payload: {},
            })
          ).statusCode,
          401,
        );
        const session = await db.widgetSession.findFirstOrThrow({
          where: { orgId, revokedAt: null },
        });
        const signed = await (
          await bridgeSigner(privatePath)
        )(sessionGrant(session, [published.revision.id]));
        const malformed = await bridge.inject({
          method: 'POST',
          url: '/mcp',
          headers: {
            authorization: `Bearer ${signed}`,
            accept: 'application/json, text/event-stream',
          },
          payload: { not: 'jsonrpc' },
        });
        assert.ok(malformed.statusCode >= 400, malformed.body);
        assert.equal((await bridge.inject({ url: '/mcp' })).statusCode, 405);
      });
      await t.test(
        'manual tool tests share approvals and do not require an LLM response',
        async () => {
          const tool = published.tools.find((t: any) => t.definition.name === 'create_task');
          const r = await app.inject({
            method: 'POST',
            url: `/v1/widget/conversations/${conv.id}/tool-test`,
            headers: wh(),
            payload: { toolId: tool.id, arguments: { body: { title: 'Manual MCP test' } } },
          });
          const pending = event(r.body, 'approval');
          assert.ok(pending, r.body);
          const result = await approve(pending.id);
          assert.equal(event(result.body, 'error'), null, result.body);
          assert.ok(event(result.body, 'action_completed'));
          assert.ok(event(result.body, 'delta').text.includes('Tool test result'));
        },
      );
      await t.test(
        'two mapped tenants with the same user cannot use one another’s credentials or conversations',
        async () => {
          const second = await app.inject({
            method: 'POST',
            url: '/v1/auth/signup',
            headers: { origin },
            payload: {
              name: 'Other owner',
              email: `other-${randomUUID()}@example.test`,
              password: 'Other-password-123',
              organization: 'Other bridge tenant',
            },
          });
          assert.equal(second.statusCode, 200);
          const cookieB = String(second.headers['set-cookie']).split(';')[0];
          otherOrg = (
            await app.inject({ url: '/v1/auth/me', headers: { origin, cookie: cookieB } })
          ).json().orgId;
          const postB = async (url: string, payload: any) => {
            const r = await app.inject({
              method: 'POST',
              url,
              headers: { origin, cookie: cookieB },
              payload,
            });
            assert.equal(r.statusCode, 200, r.body);
            return r.json();
          };
          const b = await postB('/v1/bridges', {
            ...draft,
            name: 'Tenant B bridge',
            tenantId: 'mcp-tenant-b',
          });
          const p = await postB(`/v1/bridges/${b.id}/publish`, {});
          const agent = await postB('/v1/agents', {
            name: 'B agent',
            description: 'B',
            prompt: 'Use permitted tools',
            model: 'test-model',
            toolIds: p.tools.map((t: any) => t.id),
          });
          const version = await postB(`/v1/agents/${agent.id}/publish`, {});
          const depB = await postB('/v1/deployments', {
            name: 'B app',
            versionId: version.id,
            origins: [hostOrigin],
            theme: { template: 'floating' },
          });
          const sessionB = await app.inject({
            method: 'POST',
            url: '/v1/widget-sessions',
            headers: { authorization: `Bearer ${depB.integrationKey}` },
            payload: {
              deploymentId: depB.id,
              userId: 'alice',
              tenantId: 'mcp-tenant-b',
              origin: hostOrigin,
              useDeploymentTools: true,
              apiToken: 'opaque-user-b-token',
              apiTokenExpiresAt: new Date(Date.now() + 300000).toISOString(),
            },
          });
          assert.equal(sessionB.statusCode, 200, sessionB.body);
          const headersB = {
            ...wh(),
            authorization: `Bearer ${sessionB.json().token}`,
            'x-deployment-id': depB.id,
          };
          assert.equal(
            (await app.inject({ url: '/v1/widget/config', headers: headersB })).statusCode,
            200,
          );
          assert.equal(
            (await app.inject({ url: `/v1/widget/conversations/${conv.id}`, headers: headersB }))
              .statusCode,
            404,
          );
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url: `/v1/widget/conversations/${conv.id}/approve`,
                headers: headersB,
                payload: { id: executedAction, approved: true },
              })
            ).statusCode,
            404,
          );
          assert.equal(
            (
              await app.inject({
                url: '/v1/widget/config',
                headers: { ...headersB, 'x-deployment-id': dep.id },
              })
            ).statusCode,
            403,
          );
          const a = await db.widgetSession.findFirstOrThrow({ where: { orgId, revokedAt: null } }),
            bSession = await db.widgetSession.findFirstOrThrow({
              where: { orgId: otherOrg, revokedAt: null },
            });
          const signed = await (
            await bridgeSigner(privatePath)
          )({ ...sessionGrant(bSession, [p.revision.id]), bindingId: a.credentialHandle! });
          const stolen = await bridge.inject({
            method: 'POST',
            url: '/mcp',
            headers: { authorization: `Bearer ${signed}` },
            payload: {},
          });
          assert.equal(stolen.statusCode, 403);
          const edit = await app.inject({
            method: 'PATCH',
            url: `/v1/bridges/${created.id}`,
            headers: { origin, cookie: cookieB },
            payload: draft,
          });
          assert.equal(edit.statusCode, 404);
        },
      );
      await t.test('revision mismatches and Redis credential loss prevent execution', async () => {
        const session = await db.widgetSession.findFirstOrThrow({
          where: { orgId, revokedAt: null },
        });
        const version = await db.agentVersion.findUniqueOrThrow({ where: { id: dep.versionId } });
        const tool = (version.config as any).tools[0];
        await assert.rejects(
          discoverBridgeTools(
            session,
            [{ ...tool, bridgeFingerprint: 'modified' }],
            AbortSignal.timeout(5000),
          ),
          /differs/,
        );
        const redis = createClient({
          url: process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:56379',
        });
        await redis.connect();
        const value = await redis.get('ao:credential:' + session.credentialHandle);
        assert.ok(value);
        assert.equal(value!.includes('apiToken'), false);
        await redis.del('ao:credential:' + session.credentialHandle);
        await redis.quit();
        assert.equal(
          (await app.inject({ url: '/v1/widget/config', headers: wh() })).statusCode,
          401,
        );
        const refreshed = await host.inject({
          method: 'POST',
          url: '/assistant/session',
          headers: { cookie: hostCookie, origin: hostOrigin },
          payload: { deploymentId: dep.id },
        });
        assert.equal(refreshed.statusCode, 200, refreshed.body);
        access = refreshed.json();
        assert.equal(
          (await app.inject({ url: `/v1/widget/conversations/${conv.id}`, headers: wh() }))
            .statusCode,
          200,
        );
      });
      await t.test(
        'editing draft preserves published revision and explicit migration preserves source',
        async () => {
          await request(`/v1/bridges/${created.id}`, { ...draft, name: 'Draft only' }, 'PATCH');
          const rev = await db.bridgeRevision.findUniqueOrThrow({
            where: { id: published.revision.id },
          });
          assert.equal((rev.config as any).name, 'Taskboard MCP');
          const c = await request('/v1/connections', { name: 'Unchanged direct', baseUrl: base });
          const migrated = await request(`/v1/connections/${c.id}/migrate-to-bridge`, {
            tenantId: 'mcp-tenant',
            origins: [hostOrigin],
          });
          assert.ok(migrated.id);
          assert.equal(
            (await db.connection.findUniqueOrThrow({ where: { id: c.id } })).bridgeRevisionId,
            null,
          );
        },
      );
      await t.test(
        'bridge disable revokes the widget credential and prevents execution',
        async () => {
          await request(`/v1/bridges/${created.id}/active`, { active: false });
          assert.equal(
            (await app.inject({ url: '/v1/widget/config', headers: wh() })).statusCode,
            401,
          );
        },
      );
    } finally {
      await host?.close();
      await app.close();
      await bridge.close();
      if (orgId) {
        const conversations = await db.conversation.findMany({
          where: { orgId: { in: [orgId, otherOrg].filter(Boolean) } },
          select: { id: true },
        });
        await db.message.deleteMany({
          where: { conversationId: { in: conversations.map((x) => x.id) } },
        });
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
            where:
              table === 'organization'
                ? { id: { in: [orgId, otherOrg].filter(Boolean) } }
                : { orgId: { in: [orgId, otherOrg].filter(Boolean) } },
          });
      }
      await db.$disconnect();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
