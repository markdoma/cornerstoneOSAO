import '../env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agentInput, parseTool } from '@orchestrator/core';

test(
  'MCP-only setup retires direct creation while preserving published deployments and explicit migration',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    process.env.LEGACY_DIRECT_SETUP_ENABLED = 'false';
    process.env.MCP_BRIDGE_ENABLED = 'true';
    const { createApp } = await import('../../apps/api/src/server.js');
    const { config } = await import('../../apps/api/src/config.js');
    const { db } = await import('../../apps/api/src/db.js');
    const { hash } = await import('../../apps/api/src/crypto.js');
    assert.equal(config.LEGACY_DIRECT_SETUP_ENABLED, false);
    const app = await createApp();
    const origin = 'http://localhost:3000';
    let orgId = '',
      userId = '';
    try {
      const signup = await app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        headers: { origin },
        payload: {
          email: `mcp-policy-${randomUUID()}@example.test`,
          password: 'Long-password-123',
          name: 'MCP Owner',
          organization: 'MCP Policy Test',
        },
      });
      assert.equal(signup.statusCode, 200, signup.body);
      const cookie = String(signup.headers['set-cookie']).split(';')[0];
      const me = (await app.inject({ url: '/v1/auth/me', headers: { cookie, origin } })).json();
      orgId = me.orgId;
      userId = me.userId;
      const request = (url: string, payload?: any, method?: any) =>
        app.inject({
          method: method ?? (payload === undefined ? 'GET' : 'POST'),
          url,
          headers: { cookie, origin },
          payload,
        });
      // Seed a previously published direct deployment; no new setup API is used.
      const connection = await db.connection.create({
        data: { orgId, name: 'Previous direct connection', baseUrl: 'http://127.0.0.1:3002/api' },
      });
      const definition = parseTool({
        name: 'list_tasks',
        description: 'Read my tasks',
        method: 'GET',
        path: '/tasks',
        kind: 'read',
        schema: { type: 'object', properties: {}, additionalProperties: false },
      });
      const tool = await db.tool.create({
        data: { orgId, connectionId: connection.id, definition: definition as any, enabled: true },
      });
      const draft = agentInput.parse({
        name: 'Existing assistant',
        model: 'test-model',
        prompt: 'Help the user',
        toolIds: [tool.id],
      });
      const agent = await db.agent.create({ data: { orgId, draft: draft as any } });
      const version = await db.agentVersion.create({
        data: {
          orgId,
          agentId: agent.id,
          number: 1,
          config: {
            ...draft,
            tools: [
              {
                ...definition,
                id: tool.id,
                connectionId: connection.id,
                baseUrl: connection.baseUrl,
              },
            ],
          } as any,
        },
      });
      const dep = await db.deployment.create({
        data: {
          orgId,
          versionId: version.id,
          name: 'Existing live assistant',
          origins: ['http://localhost:3002'],
          theme: { template: 'floating' },
          keyHash: hash(randomUUID()),
          authMode: 'exchange',
        },
      });

      await t.test('connector downloads use a fixed public language catalog', async () => {
        const { connectorCatalog } = await import('../../packages/bridge/src/connector-catalog.js');
        for (const item of connectorCatalog) {
          const r = await app.inject({ url: '/host-connectors/' + item.id });
          assert.equal(r.statusCode, 200, item.id);
          assert.match(r.headers['content-type'] ?? '', /text\/plain/);
          assert.ok(String(r.headers['content-disposition']).includes(item.filename));
          assert.ok(r.body.includes('/v1/widget-sessions'));
        }
        assert.equal((await app.inject({ url: '/host-connectors/env' })).statusCode, 404);
        assert.equal((await app.inject({ url: '/host-connectors/%2e%2e%2f.env' })).statusCode, 404);
      });
      await t.test(
        'direct connection creation and direct import/tool APIs return actionable HTTP 410',
        async () => {
          for (const [url, payload] of [
            ['/v1/connections', { name: 'New direct', baseUrl: connection.baseUrl }],
            ['/v1/tools/import', { spec: '{}' }],
            ['/v1/tools', { connectionId: connection.id, definition, enabled: true }],
          ] as const) {
            const r = await request(url, payload);
            assert.equal(r.statusCode, 410, r.body);
            assert.match(r.json().error, /MCP Bridges/);
          }
          const edit = await request(`/v1/tools/${tool.id}`, { definition }, 'PATCH');
          assert.equal(edit.statusCode, 410, edit.body);
        },
      );
      await t.test(
        'direct tool IDs cannot bypass the agent or deployment publishing policy',
        async () => {
          for (const [url, payload] of [
            ['/v1/agents', draft],
            [`/v1/agents/${agent.id}/publish`, {}],
            [
              '/v1/deployments',
              {
                versionId: version.id,
                name: 'New direct deployment',
                origins: ['http://localhost:3002'],
                theme: { template: 'floating' },
              },
            ],
          ] as const) {
            const r = await request(url, payload);
            assert.equal(r.statusCode, 410, r.body);
          }
          const update = await request(`/v1/agents/${agent.id}`, draft, 'PATCH');
          assert.equal(update.statusCode, 410, update.body);
        },
      );
      await t.test(
        'existing deployment remains pinned and manageable; disabling its tool remains available',
        async () => {
          const before = await db.deployment.findUniqueOrThrow({ where: { id: dep.id } });
          assert.equal(before.active, true);
          assert.equal(before.versionId, version.id);
          const r = await request(
            `/v1/deployments/${dep.id}`,
            { versionId: version.id, theme: { template: 'inline' } },
            'PATCH',
          );
          assert.equal(r.statusCode, 200, r.body);
          const disable = await request(`/v1/tools/${tool.id}`, { enabled: false }, 'PATCH');
          assert.equal(disable.statusCode, 200, disable.body);
          assert.equal(
            (await db.deployment.findUniqueOrThrow({ where: { id: dep.id } })).authMode,
            'exchange',
          );
        },
      );
      await t.test(
        'saved direct definitions can be explicitly copied into a bridge draft',
        async () => {
          const r = await request(`/v1/connections/${connection.id}/migrate-to-bridge`, {
            tenantId: `mcp-policy-${randomUUID()}`,
            origins: ['http://localhost:3002'],
          });
          assert.equal(r.statusCode, 200, r.body);
          assert.equal(r.json().draft.operations.length, 1);
          const after = await db.deployment.findUniqueOrThrow({ where: { id: dep.id } });
          assert.equal(after.versionId, version.id);
          assert.equal(await db.connection.count({ where: { id: connection.id, orgId } }), 1);
        },
      );
    } finally {
      await app.close();
      if (orgId) {
        for (const table of [
          'bridge',
          'deployment',
          'agentVersion',
          'agent',
          'tool',
          'connection',
          'auditEvent',
          'dashboardSession',
          'membership',
        ] as const)
          await (db[table] as any).deleteMany({ where: { orgId } });
        await db.organization.deleteMany({ where: { id: orgId } });
      }
      if (userId) await db.user.deleteMany({ where: { id: userId } });
      await db.$disconnect();
    }
  },
);
