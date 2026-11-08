import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../apps/sample-host/src/server.js';
import {
  createRelaySessionHandler,
  type HostSession,
} from '../packages/relay-server/connector.mjs';
const applicationOrigin = 'https://customer.example';
const widgetOrigin = 'https://relay.example';
function request(body: unknown = {}, origin = applicationOrigin) {
  return new Request(`${applicationOrigin}/assistant/session`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function setup(
  options: {
    signedIn?: boolean;
    toolIds?: string[];
    duringExchange?: () => void;
    throwUpstream?: boolean;
  } = {},
) {
  let active = options.signedIn !== false;
  const requests: { url: string; body: any; authorization: string | null }[] = [];
  const access = {
    token: 'w'.repeat(43),
    expiresAt: new Date(Date.now() + 180000).toISOString(),
    deploymentId: 'deployment_1',
    widgetOrigin,
  };
  const secret = 'server-only-key',
    delegated = 'delegated-user-bearer';
  const fetcher: typeof fetch = async (input, init) => {
    if (options.throwUpstream) throw new Error(`Do not expose ${secret} or ${delegated}`);
    const url = String(input),
      headers = new Headers(init?.headers);
    requests.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      authorization: headers.get('authorization'),
    });
    if (url.endsWith('/revoke')) return Response.json({ ok: true });
    options.duringExchange?.();
    return Response.json({ ...access, apiToken: 'must-not-be-forwarded' });
  };
  const handler = createRelaySessionHandler({
    relayOrigin: widgetOrigin,
    applicationOrigin,
    deploymentId: 'deployment_1',
    integrationKey: secret,
    fetch: fetcher,
    getSession: async () =>
      active
        ? {
            userId: 'verified-alice',
            apiToken: delegated,
            expiresAt: new Date(Date.now() + 240000).toISOString(),
            ...(options.toolIds ? { toolIds: options.toolIds } : {}),
            isActive: () => active,
          }
        : null,
  });
  return {
    handler,
    requests,
    access,
    logout: () => {
      active = false;
    },
    secret,
    delegated,
  };
}
test('connector ignores browser identity and credentials, forwards only verified server identity', async () => {
  const { handler, requests, secret, delegated } = setup();
  const response = await handler(
    request({
      deploymentId: 'deployment_1',
      userId: 'forged-bob',
      apiToken: 'forged',
      toolIds: ['unauthorized'],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(requests[0].body.userId, 'verified-alice');
  assert.equal(requests[0].body.apiToken, delegated);
  assert.equal(requests[0].body.useDeploymentTools, true);
  assert.equal(requests[0].body.toolIds, undefined);
  const body = await response.text();
  assert.ok(!body.includes(secret));
  assert.ok(!body.includes(delegated));
  assert.ok(!body.includes('must-not-be-forwarded'));
});
test('connector fails closed for signed-out users, unknown deployments, cross-origin and oversized requests', async () => {
  let scenario = setup({ signedIn: false });
  assert.equal((await scenario.handler(request())).status, 401);
  assert.equal(scenario.requests.length, 0);
  scenario = setup();
  assert.equal((await scenario.handler(request({}, 'https://attacker.example'))).status, 403);
  assert.equal(
    (await scenario.handler(request({ deploymentId: 'another-deployment' }))).status,
    403,
  );
  assert.equal((await scenario.handler(request({ large: 'a'.repeat(3000) }))).status, 413);
  assert.equal(scenario.requests.length, 0);
});
test('connector preserves explicit empty tool restrictions', async () => {
  const { handler, requests } = setup({ toolIds: [] });
  assert.equal((await handler(request())).status, 200);
  assert.deepEqual(requests[0].body.toolIds, []);
  assert.equal(requests[0].body.useDeploymentTools, undefined);
});
test('connector revokes a token issued during host logout and never returns it', async () => {
  let scenario: ReturnType<typeof setup>;
  scenario = setup({ duringExchange: () => scenario.logout() });
  const response = await scenario.handler(request());
  assert.equal(response.status, 401);
  assert.ok(!JSON.stringify(await response.json()).includes(scenario.access.token));
  assert.equal(scenario.requests[1].url, `${widgetOrigin}/v1/widget/revoke`);
});
test('connector errors never disclose integration keys or delegated API tokens', async () => {
  const { handler, secret, delegated } = setup({ throwUpstream: true });
  const response = await handler(request());
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.ok(!body.includes(secret));
  assert.ok(!body.includes(delegated));
});
test('connector requires HTTPS outside explicit localhost development', () => {
  const base = {
    applicationOrigin,
    relayOrigin: 'http://relay.example',
    deploymentId: 'one',
    integrationKey: 'key',
    getSession: async (): Promise<HostSession | null> => null,
  };
  assert.throws(() => createRelaySessionHandler(base), /HTTPS/);
  assert.throws(
    () => createRelaySessionHandler({ ...base, relayOrigin: 'http://localhost:4000' }),
    /HTTPS/,
  );
  assert.doesNotThrow(() =>
    createRelaySessionHandler({
      ...base,
      relayOrigin: 'http://localhost:4000',
      allowLocalhost: true,
    }),
  );
});

test('sample host never renders a misplaced integration credential as a deployment ID', async () => {
  const misplacedCredential = 'not-a-public-id-' + 'x'.repeat(32);
  const host = await createHost({
    apiUrl: 'http://localhost:4000',
    widgetOrigin: 'http://localhost:4000',
    origin: 'http://localhost:3002',
    integrationKey: 'server-key',
    deploymentId: misplacedCredential,
    toolIds: [],
  });
  try {
    const page = await host.inject({ url: '/' });
    assert.equal(page.statusCode, 200);
    assert.ok(!page.body.includes(misplacedCredential));
    assert.ok(!page.body.includes('data-deployment='));
  } finally {
    await host.close();
  }
});
