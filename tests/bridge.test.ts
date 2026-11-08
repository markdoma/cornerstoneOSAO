import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDraft,
  modelSchema,
  bindArguments,
  fingerprint,
} from '../packages/bridge/src/contracts.js';
import { verifyDestination } from '../packages/bridge/src/http.js';
import { inventory, importSelection } from '../packages/bridge/src/openapi.js';
const definition = {
  name: 'get_record',
  description: 'Read a scoped record',
  method: 'GET',
  path: '/records/{id}',
  kind: 'read',
  schema: {
    type: 'object',
    properties: {
      path: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      query: {
        type: 'object',
        properties: { tenantId: { type: 'string' }, employeeId: { type: 'string' } },
        required: ['tenantId'],
        additionalProperties: false,
      },
    },
    required: ['path', 'query'],
    additionalProperties: false,
  },
};
const draft = () =>
  parseDraft({
    name: 'HRIS',
    baseUrl: 'https://hris.example/api',
    origins: ['https://hris.example'],
    tenantId: 'tenant-a',
    operations: [
      {
        id: 'read',
        definition,
        enabled: true,
        bindings: [
          { location: 'query', name: 'tenantId', source: 'tenantId' },
          { location: 'query', name: 'employeeId', source: 'employeeId' },
        ],
      },
    ],
  });
test('bridge identity bindings hide fields from model and inject verified values only', () => {
  const op = draft().operations[0];
  assert.equal(modelSchema(op).properties?.query, undefined);
  assert.throws(
    () =>
      bindArguments(
        op,
        { path: { id: 'record' }, query: { tenantId: 'other' } },
        { tenantId: 'tenant-a', userId: 'alice', employeeId: 'employee-1' },
      ),
    /unexpected|unknown|Unknown/i,
  );
  assert.deepEqual(
    bindArguments(
      op,
      { path: { id: 'record' } },
      { tenantId: 'tenant-a', userId: 'alice', employeeId: 'employee-1' },
    ).args,
    { path: { id: 'record' }, query: { tenantId: 'tenant-a', employeeId: 'employee-1' } },
  );
  assert.throws(
    () => bindArguments(op, { path: { id: 'record' } }, { tenantId: 'tenant-a', userId: 'alice' }),
    /employeeId/,
  );
});
test('bridge cannot bind authorization/cookie headers or mark POST as read', () => {
  for (const name of ['Authorization', 'Cookie', 'Host', '__proto__'])
    assert.throws(() =>
      parseDraft({
        ...draft(),
        operations: [
          {
            id: 'bad',
            definition,
            bindings: [{ location: 'header', name, source: 'userId' }],
            enabled: true,
          },
        ],
      }),
    );
  assert.throws(
    () =>
      parseDraft({
        ...draft(),
        operations: [
          { id: 'bad', definition: { ...definition, method: 'POST' }, bindings: [], enabled: true },
        ],
      }),
    /GET/,
  );
});
test('bridge fingerprints are stable and change for a schema or action mutation', () => {
  const original = draft();
  assert.equal(fingerprint(original), fingerprint(JSON.parse(JSON.stringify(original))));
  assert.notEqual(fingerprint(original), fingerprint({ ...original, tenantId: 'b' }));
});
test('large OpenAPI inventory can select operations before schema validation', () => {
  const paths: any = {};
  for (let i = 0; i < 100; i++)
    paths['/records/' + i] = {
      get: {
        operationId: 'get_record_' + i,
        summary: 'Read a record',
        responses: { 200: { description: 'OK' } },
      },
    };
  paths['/unsupported'] = {
    post: {
      operationId: 'bad',
      requestBody: {
        content: {
          'application/json': {
            schema: { type: 'object', properties: { value: { type: 'string', nullable: true } } },
          },
        },
      },
      responses: { 200: { description: 'OK' } },
    },
  };
  const text = JSON.stringify({
    openapi: '3.0.3',
    info: { description: 'x'.repeat(600000) },
    paths,
  });
  assert.ok(text.length > 500000);
  assert.equal(inventory(text).length, 101);
  assert.equal(importSelection(text, ['GET /records/0'])[0].definition.name, 'get_record_0');
  assert.throws(() => importSelection(text, ['POST /unsupported']), /POST \/unsupported.*nullable/);
  assert.throws(
    () =>
      importSelection(
        text,
        Array.from({ length: 41 }, (_, i) => 'GET /records/' + i),
      ),
    /1–40/,
  );
});
test('selected local component references are preserved without importing unrelated schemas', () => {
  const text = JSON.stringify({
    openapi: '3.0.4',
    components: {
      schemas: {
        Input: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
          additionalProperties: false,
        },
        Unused: { type: 'object', properties: { free: {} } },
      },
    },
    paths: {
      '/create': {
        post: {
          operationId: 'create',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } },
          },
          responses: { 200: { description: 'OK' } },
        },
      },
    },
  });
  assert.equal(
    importSelection(text, ['POST /create'])[0].definition.schema.properties?.body.properties?.name
      .type,
    'string',
  );
});

test('host session endpoints are same-origin paths and old bridge drafts retain their default', () => {
  const previous = draft();
  assert.equal(previous.sessionEndpoint, '/assistant/session');
  const customized = parseDraft({ ...previous, sessionEndpoint: '/api/ao/session' });
  assert.equal(customized.sessionEndpoint, '/api/ao/session');
  assert.notEqual(fingerprint(previous), fingerprint(customized));
  for (const sessionEndpoint of [
    '',
    'assistant/session',
    'https://outside.example/session',
    '//outside.example/session',
    '/foo/../session',
    '/session?token=secret',
    '/session#fragment',
    '/%2foutside',
    '/session" onclick="bad',
    '/session\\other',
  ]) {
    assert.throws(() => parseDraft({ ...previous, sessionEndpoint }), /same-origin|Too small/);
  }
});

test('local integration lab exception covers only explicitly listed loopback API prefixes', async () => {
  const env = process.env as Record<string, string | undefined>;
  const previous = { mode: env.NODE_ENV, allow: env.ALLOW_LOCAL_DEMO_API };
  try {
    env.NODE_ENV = 'test';
    env.ALLOW_LOCAL_DEMO_API = 'http://127.0.0.1:3002/api,http://127.0.0.1:3003/api';
    for (const port of [3002, 3003]) {
      assert.deepEqual(await verifyDestination(`http://127.0.0.1:${port}/api/tasks`), [
        { address: '127.0.0.1', family: 4 },
      ]);
    }
    await assert.rejects(verifyDestination('http://127.0.0.1:3003/api-other'), /HTTPS/);
    await assert.rejects(verifyDestination('http://127.0.0.1:3004/api'), /HTTPS/);
    env.NODE_ENV = 'production';
    await assert.rejects(verifyDestination('http://127.0.0.1:3003/api/tasks'), /HTTPS/);
  } finally {
    if (previous.mode === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = previous.mode;
    if (previous.allow === undefined) delete env.ALLOW_LOCAL_DEMO_API;
    else env.ALLOW_LOCAL_DEMO_API = previous.allow;
  }
});
