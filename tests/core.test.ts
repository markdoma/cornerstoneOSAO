import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSchema, validateValue, parseTool, importOpenAPI } from '@orchestrator/core';
import { sampleSpecification } from '../apps/sample-host/src/server.js';
import { publicAddress, verifyDestination, buildToolUrl, redact } from '../apps/api/src/network.js';
import { encrypt, decrypt, actionDigest } from '../apps/api/src/crypto.js';

test('schema interpreter rejects code-oriented, recursive, and unsupported schemas', () => {
  for (const schema of [
    { type: 'object', additionalProperties: true },
    { type: 'string', pattern: 'evil' },
    { type: 'object', properties: { x: { $ref: '#/foo' } } },
    { oneOf: [{ type: 'string' }] },
    { type: 'object', required: ['missing'] },
  ])
    assert.throws(() => checkSchema(schema));
  assert.throws(() =>
    checkSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')),
  );
});
test('schema interpreter enforces types, required fields, bounds, and unknown fields', () => {
  const s = checkSchema({
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 2, maxLength: 10 },
      count: { type: 'integer', minimum: 1, maximum: 5 },
    },
    required: ['title'],
    additionalProperties: false,
  });
  validateValue(s, { title: 'Hello', count: 3 });
  for (const v of [
    { title: 'x' },
    { title: 'Hello', count: 1.5 },
    { title: 'Hello', count: 8 },
    { title: 'Hello', extra: true },
    {},
  ])
    assert.throws(() => validateValue(s, v));
});
test('OpenAPI import includes CRUD and fails atomically on unsupported features', () => {
  const spec = sampleSpecification('https://example.com');
  const tools = importOpenAPI(JSON.stringify(spec));
  assert.equal(tools.length, 5);
  assert.equal(tools.find((t) => t.name === 'create_task')!.kind, 'write');
  const bad = structuredClone(spec) as any;
  bad.paths['/tasks'].post.requestBody.content = { 'text/plain': { schema: { type: 'string' } } };
  assert.throws(() => importOpenAPI(JSON.stringify(bad)), /application\/json/);
  assert.throws(() => importOpenAPI('openapi: 2.0'), /OpenAPI/);
  const unsafe = structuredClone(spec) as any;
  unsafe.paths['/tasks'].get.parameters = [
    { name: '__proto__', in: 'query', schema: { type: 'string' } },
  ];
  assert.throws(() => importOpenAPI(JSON.stringify(unsafe)), /unsafe parameter/);
});
test('all non-GET endpoints require write confirmation', () => {
  assert.throws(
    () =>
      parseTool({
        name: 'create',
        description: 'Create',
        path: '/tasks',
        method: 'POST',
        kind: 'read',
        schema: { type: 'object' },
      }),
    /Only GET/,
  );
});
test('destination checks block loopback, private networks, mapped IPv6, and mixed DNS', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.2',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '0.0.0.0',
    '100.64.0.1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  await assert.rejects(verifyDestination('https://127.0.0.1'), /public/);
  await assert.rejects(
    verifyDestination(
      'https://example.com',
      async () =>
        [
          { address: '8.8.8.8', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ] as any,
    ),
    /public/,
  );
  await assert.rejects(verifyDestination('http://example.com'), /HTTPS/);
  await assert.rejects(verifyDestination('https://user:pass@example.com'), /credentials/);
});
test('fixed URL construction rejects traversal and cannot target a model-selected origin', () => {
  const tool = parseTool({
    name: 'get_task',
    description: 'Get',
    method: 'GET',
    kind: 'read',
    path: '/tasks/{id}',
    schema: {
      type: 'object',
      properties: {
        path: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  });
  assert.equal(
    buildToolUrl('https://example.com/v1', tool, { path: { id: 'abc' } }).href,
    'https://example.com/v1/tasks/abc',
  );
  for (const id of ['..', '../admin', '%2e%2e', 'a/b', 'a\\b'])
    assert.throws(() => buildToolUrl('https://example.com/v1', tool, { path: { id } }));
  assert.throws(() => parseTool({ ...tool, path: '//evil.example/' }));
});
test('encrypted credentials authenticate ciphertext and action digests bind immutable arguments', () => {
  const encrypted = encrypt('secret-value');
  assert.notEqual(encrypted, 'secret-value');
  assert.equal(decrypt(encrypted), 'secret-value');
  const bytes = Buffer.from(encrypted, 'base64');
  bytes[14] ^= 1;
  assert.throws(() => decrypt(bytes.toString('base64')));
  assert.equal(actionDigest({ b: 2, a: 1 }), actionDigest({ a: 1, b: 2 }));
  assert.notEqual(actionDigest({ args: { id: 1 } }), actionDigest({ args: { id: 2 } }));
});
test('API result redaction removes credentials before model consumption', () => {
  assert.deepEqual(
    redact({ password: 'p', access_token: 't', nested: { message: 'hello bearer-value' } }, [
      'bearer-value',
    ]),
    { password: '[REDACTED]', access_token: '[REDACTED]', nested: { message: 'hello [REDACTED]' } },
  );
});
