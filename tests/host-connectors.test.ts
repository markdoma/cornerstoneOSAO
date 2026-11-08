import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { connectorCatalog } from '../packages/bridge/src/connector-catalog.js';

test('connector catalog has self-contained sources for every offered language', async () => {
  assert.equal(new Set(connectorCatalog.map((c) => c.id)).size, 7);
  for (const c of connectorCatalog) {
    const source = await readFile(
      new URL('../integrations/host-connectors/' + c.source, import.meta.url),
      'utf8',
    );
    assert.ok(source.includes('/v1/widget-sessions'), c.id);
    assert.ok(source.includes('/v1/widget/revoke'), c.id);
    assert.ok(source.includes('AO_INTEGRATION_KEY'), c.id);
    assert.ok(source.includes('tenant'), c.id);
    assert.ok(!source.includes("from './relay-server.mjs'"), c.id);
  }
});

test('copyable Node connector ignores browser identity, enforces tenant and rechecks logout', async () => {
  Object.assign(process.env, {
    AO_ORIGIN: 'https://ao.example',
    AO_WIDGET_ORIGIN: 'https://widget.example',
    AO_APPLICATION_ORIGIN: 'https://host.example',
    AO_DEPLOYMENT_ID: 'configured-deployment',
    AO_INTEGRATION_KEY: 'server-secret',
    AO_TENANT_ID: 'tenant-a',
  });
  const source = (
    await readFile(new URL('../integrations/host-connectors/node.mjs', import.meta.url), 'utf8')
  ).replace(
    'return null; // Fail closed until your application adapter is implemented.',
    'return globalThis.__aoConnectorFixture;',
  );
  const savedFetch = globalThis.fetch;
  let host: any,
    calls: { url: string; body: any; headers: any }[] = [],
    tracked = 0;
  let current = true;
  (globalThis as any).__aoConnectorFixture = null;
  globalThis.fetch = (async (url: any, options: any) => {
    calls.push({
      url: String(url),
      body: options.body ? JSON.parse(options.body) : undefined,
      headers: options.headers,
    });
    if (String(url).endsWith('/v1/widget/revoke')) return Response.json({ ok: true });
    return Response.json({
      token: 'a'.repeat(43),
      deploymentId: 'configured-deployment',
      widgetOrigin: 'https://widget.example',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
  }) as any;
  try {
    const module = await import(
      'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
    );
    const request = (payload: any = {}) =>
      new Request('https://host.example/custom/session', {
        method: 'POST',
        headers: { origin: 'https://host.example', 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    assert.equal((await module.POST(request())).status, 401);
    assert.equal(calls.length, 0);
    host = {
      userId: 'alice',
      tenantId: 'tenant-a',
      apiToken: 'native-user-secret',
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      isActive: async () => current,
      onIssued: async () => {
        tracked++;
      },
    };
    (globalThis as any).__aoConnectorFixture = host;
    const response = await module.POST(
      request({ userId: 'bob', tenantId: 'other', apiToken: 'forged', toolIds: ['admin'] }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(calls[0].body.userId, 'alice');
    assert.equal(calls[0].body.tenantId, 'tenant-a');
    assert.equal(calls[0].body.apiToken, 'native-user-secret');
    assert.equal(calls[0].body.useDeploymentTools, true);
    assert.equal(calls[0].headers.authorization, 'Bearer server-secret');
    assert.equal(tracked, 1);
    assert.ok(!(await response.text()).includes('native-user-secret'));
    host.tenantId = 'tenant-b';
    calls = [];
    assert.equal((await module.POST(request())).status, 401);
    assert.equal(calls.length, 0);
    host.tenantId = 'tenant-a';
    let checks = 0;
    host.isActive = async () => ++checks === 1;
    assert.equal((await module.POST(request())).status, 401);
    assert.ok(calls.some((c) => c.url.endsWith('/v1/widget/revoke')));
  } finally {
    globalThis.fetch = savedFetch;
    delete (globalThis as any).__aoConnectorFixture;
  }
});
