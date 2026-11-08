import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT, createLocalJWKSet } from 'jose';
import {
  createIssuer,
  verifier,
  RequireInternalServiceContext,
  assertIdentity,
} from '../packages/delegation/src/index.js';
const keys = await generateKeyPair('EdDSA', { extractable: true });
const issuer = await createIssuer({
  privateKey: await exportPKCS8(keys.privateKey),
  publicKey: await exportSPKI(keys.publicKey),
  kid: 'test-key',
});
const identity = {
  sub: 'alice',
  tenant_id: 'tenant-a',
  roles: ['employee'],
  scopes: ['tool:create_task'],
};
const secret = 's'.repeat(48);
test('asymmetric JWT minting includes ten-minute lifetime and public-only JWKS', async () => {
  const raw = await issuer.mint(identity);
  const context = await issuer.verify(raw);
  assert.equal(context.sub, 'alice');
  assert.equal(context.exp - context.iat, 600);
  assert.equal(JSON.stringify(issuer.jwks).includes('"d"'), false);
});
test('JWT verifier rejects expiry, wrong issuer/audience, altered signatures and long lifetimes', async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const change of [
    { exp: now - 1, iat: now - 601 },
    { iss: 'attacker' },
    { aud: 'another-service' },
    { exp: now + 601 },
    { tenant_id: undefined },
    { roles: 'admin' },
  ]) {
    const raw = await new SignJWT({
      ...identity,
      iss: 'hris.internal',
      aud: 'ai-orchestrator.internal',
      jti: 'test',
      iat: now,
      exp: now + 600,
      ...change,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key', typ: 'JWT' })
      .sign(keys.privateKey);
    await assert.rejects(issuer.verify(raw), { statusCode: 401 });
  }
  const raw = await issuer.mint(identity);
  await assert.rejects(issuer.verify(raw.slice(0, -8) + 'abcdefgh'), { statusCode: 401 });
});
test('algorithm confusion and unknown keys fail closed', async () => {
  const now = Math.floor(Date.now() / 1000);
  const raw = await new SignJWT({
    ...identity,
    iss: 'hris.internal',
    aud: 'ai-orchestrator.internal',
    iat: now,
    exp: now + 600,
    jti: 'x',
  })
    .setProtectedHeader({ alg: 'HS256', kid: 'test-key', typ: 'JWT' })
    .sign(new TextEncoder().encode(secret));
  await assert.rejects(issuer.verify(raw), { statusCode: 401 });
  const changed = await new SignJWT({
    ...identity,
    iss: 'hris.internal',
    aud: 'ai-orchestrator.internal',
    iat: now,
    exp: now + 600,
    jti: 'x',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'unknown', typ: 'JWT' })
    .sign(keys.privateKey);
  await assert.rejects(issuer.verify(changed), { statusCode: 401 });
});
test('internal middleware requires both service identity and valid user context', async () => {
  const raw = await issuer.mint(identity);
  const gate = RequireInternalServiceContext({ serviceToken: secret, verify: issuer.verify });
  for (const headers of [
    {},
    { authorization: `Bearer ${secret}` },
    { 'x-user-context': raw },
    { authorization: 'Bearer wrong', 'x-user-context': raw },
  ])
    await assert.rejects(gate({ headers }), { statusCode: 401 });
  const req: any = {
    headers: { authorization: `Bearer ${secret}`, 'x-user-context': raw },
    body: { tenant_id: 'tenant-a', user_id: 'alice' },
  };
  await gate(req);
  assert.equal(req.userContext.sub, 'alice');
});
test('nested user and tenant spoofing are rejected', () => {
  for (const value of [
    { tenant_id: 'tenant-b' },
    { user_id: 'bob' },
    { nested: [{ tenantId: 'tenant-b' }] },
    { path: { sub: 'bob' } },
  ])
    assert.throws(() => assertIdentity(value, identity), { statusCode: 403 });
});
test('retired key overlap supports rotation', async () => {
  const key2 = await generateKeyPair('RS256', { extractable: true });
  const next = await createIssuer({
    privateKey: await exportPKCS8(key2.privateKey),
    publicKey: await exportSPKI(key2.publicKey),
    algorithm: 'RS256',
    kid: 'next-key',
    previousPublicKeys: issuer.jwks.keys,
  });
  const verify = verifier(createLocalJWKSet(next.jwks));
  assert.equal((await verify(await issuer.mint(identity))).sub, 'alice');
  assert.equal((await verify(await next.mint(identity))).sub, 'alice');
});
