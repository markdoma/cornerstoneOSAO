import '../env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT } from 'jose';
import { createIssuer } from '../../packages/delegation/src/index.js';
import { createHost, sampleSpecification } from '../../apps/sample-host/src/server.js';

test(
  'first-party JWT chat and dual-layer HRIS action execution',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const keys = await generateKeyPair('EdDSA', { extractable: true });
    const issuer = await createIssuer({
      privateKey: await exportPKCS8(keys.privateKey),
      publicKey: await exportSPKI(keys.publicKey),
      kid: 'integration',
    });
    const serviceToken = 'integration-service-'.repeat(3);
    const hostOrigin = 'http://localhost:3002';
    const host = await createHost({
      origin: hostOrigin,
      widgetOrigin: 'http://localhost:4000',
      apiUrl: 'http://localhost:4000',
      deploymentId: '',
      integrationKey: '',
      toolIds: [],
      firstParty: { issuer, serviceToken, tenantId: 'tenant-a' },
    });
    await host.listen({ host: '127.0.0.1', port: 0 });
    const port = (host.server.address() as any).port;
    const base = `http://127.0.0.1:${port}/internal/v1`;
    process.env.FIRST_PARTY_JWKS_URL = `http://127.0.0.1:${port}/.well-known/jwks.json`;
    process.env.HRIS_INTERNAL_API_BASE_URL = base;
    process.env.AO_SERVICE_TOKEN = serviceToken;
    process.env.ALLOW_LOCAL_DEMO_API = base;
    const orgId = 'firstparty-' + randomUUID();
    const otherOrgId = 'firstparty-other-' + randomUUID();
    process.env.FIRST_PARTY_TENANT_ORGS = JSON.stringify({
      'tenant-a': orgId,
      'tenant-b': otherOrgId,
    });
    const { db } = await import('../../apps/api/src/db.js');
    const { importOpenAPI } = await import('../../packages/core/src/index.js');
    const { createApp } = await import('../../apps/api/src/server.js');
    let target = '';
    let operation = 'create_task';
    const model: any = async ({ input }: any) =>
      input.at(-1).type === 'function_call_output'
        ? { id: randomUUID(), text: 'Done', calls: [], inputTokens: 1, outputTokens: 1 }
        : {
            id: randomUUID(),
            text: '',
            calls: [
              {
                id: randomUUID(),
                name: operation,
                arguments: JSON.stringify(
                  operation === 'create_task'
                    ? { body: { title: 'JWT-created' } }
                    : operation === 'list_tasks'
                      ? {}
                      : { path: { id: target }, body: { done: true } },
                ),
              },
            ],
            inputTokens: 1,
            outputTokens: 1,
          };
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const event = (s: string, name: string) => {
      const part = s.split('\n\n').find((p) => p.startsWith(`event: ${name}\n`));
      return part ? JSON.parse(part.split('\ndata: ')[1]) : null;
    };
    try {
      await db.organization.create({ data: { id: orgId, name: 'First-party integration' } });
      const agent = await db.agent.create({ data: { orgId, draft: {} } });
      const connection = await db.connection.create({
        data: { orgId, name: 'HRIS internal', baseUrl: base },
      });
      const definitions = importOpenAPI(JSON.stringify(sampleSpecification(hostOrigin)));
      const tools = [];
      for (const definition of definitions)
        tools.push(
          await db.tool.create({
            data: {
              orgId,
              connectionId: connection.id,
              definition: definition as any,
              enabled: true,
            },
          }),
        );
      const version = await db.agentVersion.create({
        data: {
          orgId,
          agentId: agent.id,
          number: 1,
          config: {
            name: 'HR Assistant',
            description: '',
            prompt: 'Use the tools',
            model: 'test-model',
            welcome: 'Hello',
            starters: [],
            toolIds: tools.map((x) => x.id),
            tools: tools.map((x) => ({
              ...(x.definition as any),
              id: x.id,
              connectionId: connection.id,
              baseUrl: base,
            })),
          },
        },
      });
      const dep = await db.deployment.create({
        data: {
          orgId,
          versionId: version.id,
          name: 'HRIS',
          keyHash: randomUUID(),
          origins: [hostOrigin],
          theme: { template: 'floating' },
        },
      });
      await db.organization.create({ data: { id: otherOrgId, name: 'Second valid tenant' } });
      const otherAgent = await db.agent.create({ data: { orgId: otherOrgId, draft: {} } });
      const otherVersion = await db.agentVersion.create({
        data: {
          orgId: otherOrgId,
          agentId: otherAgent.id,
          number: 1,
          config: {
            ...(version.config as any),
            name: 'Tenant B assistant',
            toolIds: [],
            tools: [],
          },
        },
      });
      const otherDeployment = await db.deployment.create({
        data: {
          orgId: otherOrgId,
          versionId: otherVersion.id,
          name: 'Tenant B',
          keyHash: randomUUID(),
          origins: [hostOrigin],
          theme: { template: 'floating' },
        },
      });
      const alternateDeployment = await db.deployment.create({
        data: {
          orgId,
          versionId: version.id,
          name: 'Same tenant, another deployment',
          keyHash: randomUUID(),
          origins: [hostOrigin],
          theme: { template: 'floating' },
        },
      });
      app = await createApp({ model });
      const identity = {
        sub: 'alice',
        tenant_id: 'tenant-a',
        roles: ['employee'],
        scopes: tools.map((x) => 'tool:' + (x.definition as any).name),
      };
      let raw = '';
      let cookie = '';
      const headers = (token = raw) => ({
        authorization: `Bearer ${token}`,
        'x-host-origin': hostOrigin,
        'x-deployment-id': dep.id,
        origin: 'http://localhost:4000',
      });
      await t.test('host session is required and JWKS contains public keys only', async () => {
        assert.equal((await host.inject({ url: '/api/internal/chat/session' })).statusCode, 401);
        const login = await host.inject({
          method: 'POST',
          url: '/login',
          headers: { origin: hostOrigin },
          payload: { user: 'alice' },
        });
        cookie = String(login.headers['set-cookie']).split(';')[0];
        const r = await host.inject({ url: '/api/internal/chat/session', headers: { cookie } });
        assert.equal(r.statusCode, 200);
        raw = r.json().user_context_token;
        assert.equal((await issuer.verify(raw)).sub, 'alice');
        assert.ok((await host.inject({ url: '/.well-known/jwks.json' })).json().keys[0].x);
      });
      await t.test(
        'AO verifies JWT directly; refuses absent, expired and forged contexts',
        async () => {
          assert.equal(
            (await app!.inject({ url: '/v1/widget/config', headers: headers() })).statusCode,
            200,
          );
          assert.equal((await app!.inject({ url: '/v1/widget/config' })).statusCode, 401);
          const now = Math.floor(Date.now() / 1000);
          const expired = await new SignJWT({
            ...identity,
            iss: 'hris.internal',
            aud: 'ai-orchestrator.internal',
            iat: now - 601,
            exp: now - 1,
            jti: 'expired',
          })
            .setProtectedHeader({ alg: 'EdDSA', kid: 'integration', typ: 'JWT' })
            .sign(keys.privateKey);
          assert.equal(
            (await app!.inject({ url: '/v1/widget/config', headers: headers(expired) })).statusCode,
            401,
          );
          assert.equal(
            (
              await app!.inject({
                url: '/v1/widget/config',
                headers: headers(raw.slice(0, -8) + 'abcdefgh'),
              })
            ).statusCode,
            401,
          );
          const other = await issuer.mint({ ...identity, tenant_id: 'other-tenant' });
          assert.equal(
            (await app!.inject({ url: '/v1/widget/config', headers: headers(other) })).statusCode,
            403,
          );
          assert.equal(
            (
              await app!.inject({
                url: '/v1/widget/config',
                headers: { ...headers(), 'x-host-origin': 'https://evil.example' },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await app!.inject({
                method: 'POST',
                url: '/v1/widget-sessions?bypass=1',
                payload: {},
              })
            ).statusCode,
            410,
          );
        },
      );
      const conversation = (
        await app.inject({ method: 'POST', url: '/v1/widget/conversations', headers: headers() })
      ).json();
      await t.test(
        'confirmed action sends both credentials, changes HRIS, and persists no token',
        async () => {
          const turn = await app!.inject({
            method: 'POST',
            url: `/v1/widget/conversations/${conversation.id}/messages`,
            headers: headers(),
            payload: { text: 'Create a task' },
          });
          const pending = event(turn.body, 'approval');
          assert.ok(pending, turn.body);
          const confirm = await app!.inject({
            method: 'POST',
            url: `/v1/widget/conversations/${conversation.id}/approve`,
            headers: headers(),
            payload: { id: pending.id, approved: true },
          });
          assert.equal(event(confirm.body, 'error'), null, confirm.body);
          assert.ok(event(confirm.body, 'action_completed'));
          const snapshot = (await host.inject({ url: '/me', headers: { cookie } })).json();
          target = snapshot.tasks.find((x: any) => x.title === 'JWT-created').id;
          assert.ok(target);
          assert.equal(await db.widgetSession.count({ where: { orgId } }), 0);
          assert.equal(await db.widgetSession.count({ where: { credential: { not: null } } }), 0);
          assert.equal(
            JSON.stringify(
              await db.message.findMany({ where: { conversationId: conversation.id } }),
            ).includes(raw),
            false,
          );
        },
      );
      await t.test(
        'HRIS rejects either missing credential and cross-user/tenant spoofing',
        async () => {
          for (const h of [
            {},
            { authorization: `Bearer ${serviceToken}` },
            { 'x-user-context': raw },
          ])
            assert.equal(
              (await host.inject({ url: '/internal/v1/tasks', headers: h })).statusCode,
              401,
            );
          const h = { authorization: `Bearer ${serviceToken}`, 'x-user-context': raw };
          assert.equal(
            (
              await host.inject({
                method: 'POST',
                url: '/internal/v1/tasks',
                headers: h,
                payload: { title: 'Spoof', tenant_id: 'other' },
              })
            ).statusCode,
            403,
          );
          const bob = await issuer.mint({ ...identity, sub: 'bob' });
          assert.equal(
            (
              await host.inject({
                method: 'PATCH',
                url: `/internal/v1/tasks/${target}`,
                headers: { ...h, 'x-user-context': bob },
                payload: { done: true, tenant_id: 'tenant-a' },
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (await host.inject({ url: '/internal/v1/tasks?user_id=bob', headers: h })).statusCode,
            403,
          );
          assert.equal(
            (
              await app!.inject({
                url: `/v1/widget/conversations/${conversation.id}`,
                headers: headers(bob),
              })
            ).statusCode,
            404,
          );
        },
      );
      await t.test(
        'two valid tenants with the same subject cannot share deployments or conversations',
        async () => {
          const tenantB = await issuer.mint({ ...identity, tenant_id: 'tenant-b' });
          const headersB = { ...headers(tenantB), 'x-deployment-id': otherDeployment.id };
          const allowed = await app!.inject({ url: '/v1/widget/config', headers: headersB });
          assert.equal(allowed.statusCode, 200);
          assert.equal(allowed.json().agent.name, 'Tenant B assistant');
          assert.equal(
            (await app!.inject({ url: '/v1/widget/config', headers: headers(tenantB) })).statusCode,
            403,
          );
          assert.equal(
            (
              await app!.inject({
                url: '/v1/widget/config',
                headers: { ...headers(), 'x-deployment-id': otherDeployment.id },
              })
            ).statusCode,
            403,
          );
          const own = await app!.inject({
            method: 'POST',
            url: '/v1/widget/conversations',
            headers: headersB,
          });
          assert.equal(own.statusCode, 200);
          assert.equal(own.json().orgId, otherOrgId);
          assert.equal(own.json().userId, identity.sub);
          for (const url of [
            `/v1/widget/conversations/${conversation.id}`,
            `/v1/widget/conversations/${own.json().id}`,
          ]) {
            const h = url.endsWith(conversation.id) ? headersB : headers();
            assert.equal((await app!.inject({ url, headers: h })).statusCode, 404);
            assert.equal(
              (
                await app!.inject({
                  method: 'POST',
                  url: url + '/messages',
                  headers: h,
                  payload: { text: 'Cross-tenant attempt' },
                })
              ).statusCode,
              404,
            );
            assert.equal(
              (
                await app!.inject({
                  method: 'POST',
                  url: url + '/approve',
                  headers: h,
                  payload: { id: 'forged', approved: true },
                })
              ).statusCode,
              404,
            );
          }
          assert.equal(
            (
              await app!.inject({
                url: `/v1/widget/conversations/${conversation.id}`,
                headers: { ...headers(), 'x-deployment-id': alternateDeployment.id },
              })
            ).statusCode,
            404,
          );
          const claimedAdmin = await issuer.mint({ ...identity, roles: ['OWNER', 'ADMIN'] });
          assert.equal(
            (await app!.inject({ url: '/v1/conversations', headers: headers(claimedAdmin) }))
              .statusCode,
            401,
          );
        },
      );
      await t.test(
        'user and conversation binding prevent approval theft without consuming the action',
        async () => {
          const proposed = await app!.inject({
            method: 'POST',
            url: `/v1/widget/conversations/${conversation.id}/messages`,
            headers: headers(),
            payload: { text: 'Create another task' },
          });
          const pending = event(proposed.body, 'approval');
          assert.ok(pending, proposed.body);
          const bob = await issuer.mint({ ...identity, sub: 'bob' });
          assert.equal(
            (
              await app!.inject({
                method: 'POST',
                url: `/v1/widget/conversations/${conversation.id}/approve`,
                headers: headers(bob),
                payload: { id: pending.id, approved: true },
              })
            ).statusCode,
            404,
          );
          const another = (
            await app!.inject({
              method: 'POST',
              url: '/v1/widget/conversations',
              headers: headers(),
            })
          ).json();
          const swapped = await app!.inject({
            method: 'POST',
            url: `/v1/widget/conversations/${another.id}/approve`,
            headers: headers(),
            payload: { id: pending.id, approved: true },
          });
          assert.equal(event(swapped.body, 'error').status, 409);
          assert.equal(
            (await db.pendingAction.findUniqueOrThrow({ where: { id: pending.id } })).status,
            'PENDING',
          );
          const rejected = await app!.inject({
            method: 'POST',
            url: `/v1/widget/conversations/${conversation.id}/approve`,
            headers: headers(),
            payload: { id: pending.id, approved: false },
          });
          assert.equal(event(rejected.body, 'error'), null, rejected.body);
        },
      );
      await t.test('refreshed token resumes same conversation without exchange', async () => {
        const fresh = await issuer.mint(identity);
        assert.equal(
          (
            await app!.inject({
              url: `/v1/widget/conversations/${conversation.id}`,
              headers: headers(fresh),
            })
          ).statusCode,
          200,
        );
        const limited = await issuer.mint({ ...identity, scopes: [] });
        operation = 'create_task';
        const r = await app!.inject({
          method: 'POST',
          url: `/v1/widget/conversations/${conversation.id}/messages`,
          headers: headers(limited),
          payload: { text: 'Create' },
        });
        assert.equal(event(r.body, 'error').status, 403);
      });
      await t.test('concurrent employees keep separate request-local identity', async () => {
        await Promise.all(
          Array.from({ length: 10 }, async (_, index) => {
            const sub = index % 2 ? 'bob' : 'alice';
            const token = await issuer.mint({ ...identity, sub });
            const result = await app!.inject({ url: '/v1/widget/config', headers: headers(token) });
            assert.equal(result.statusCode, 200);
            assert.equal(
              result.json().identity,
              createHash('sha256').update(`${orgId}:${dep.id}:${sub}`).digest('hex'),
            );
          }),
        );
      });
      await t.test('revocation rejects subsequent chat requests', async () => {
        assert.equal(
          (await app!.inject({ method: 'POST', url: '/v1/widget/revoke', headers: headers() }))
            .statusCode,
          200,
        );
        assert.equal(
          (await app!.inject({ url: '/v1/widget/config', headers: headers() })).statusCode,
          401,
        );
      });
    } finally {
      if (app) await app.close();
      await host.close();
      const conversations = await db.conversation.findMany({
        where: { orgId: { in: [orgId, otherOrgId] } },
        select: { id: true },
      });
      const ids = conversations.map((x) => x.id);
      await db.message.deleteMany({ where: { conversationId: { in: ids } } });
      for (const table of [
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
        'organization',
      ] as const)
        await (db[table] as any).deleteMany({
          where:
            table === 'organization'
              ? { id: { in: [orgId, otherOrgId] } }
              : { orgId: { in: [orgId, otherOrgId] } },
        });
      await db.$disconnect();
    }
  },
);
