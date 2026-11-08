import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  createLocalJWKSet,
  importPKCS8,
  exportJWK,
  importSPKI,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
export type UserContext = JWTPayload & {
  sub: string;
  tenant_id: string;
  roles: string[];
  scopes: string[];
  exp: number;
  iat: number;
  jti: string;
};
export const unauthorized = () =>
  Object.assign(new Error('Invalid or expired user context'), { statusCode: 401 });
export const forbidden = () =>
  Object.assign(new Error('User or tenant context mismatch'), { statusCode: 403 });
export function claims(payload: JWTPayload): UserContext {
  if (
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    payload.sub.length > 200 ||
    typeof payload.tenant_id !== 'string' ||
    !payload.tenant_id ||
    payload.tenant_id.length > 200 ||
    typeof payload.jti !== 'string' ||
    !payload.jti ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    payload.exp! - payload.iat! > 600 ||
    payload.iat! > Math.floor(Date.now() / 1000) ||
    ![payload.roles, payload.scopes].every(
      (a) =>
        Array.isArray(a) &&
        a.length <= 100 &&
        a.every((x) => typeof x === 'string' && x.length <= 200),
    )
  )
    throw unauthorized();
  return payload as UserContext;
}
export function verifier(
  key: JWTVerifyGetKey,
  issuer = 'hris.internal',
  audience = 'ai-orchestrator.internal',
) {
  return async (token: string) => {
    try {
      if (token.length > 16000) throw unauthorized();
      const result = await jwtVerify(token, key, {
        issuer,
        audience,
        algorithms: ['RS256', 'EdDSA'],
        requiredClaims: ['sub', 'tenant_id', 'roles', 'scopes', 'exp', 'iat', 'jti'],
        maxTokenAge: '10m',
        clockTolerance: 0,
      });
      if (!result.protectedHeader.kid || result.protectedHeader.typ !== 'JWT') throw unauthorized();
      return claims(result.payload);
    } catch {
      throw unauthorized();
    }
  };
}
export function remoteVerifier(url: string, allowLocal = false) {
  const u = new URL(url);
  if (
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    (u.protocol !== 'https:' &&
      !(
        allowLocal &&
        process.env.NODE_ENV !== 'production' &&
        u.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
      ))
  )
    throw new Error('JWKS must use a fixed HTTPS address');
  return verifier(
    createRemoteJWKSet(u, { timeoutDuration: 5000, cacheMaxAge: 300000, cooldownDuration: 30000 }),
  );
}
export async function createIssuer(options: {
  privateKey: string;
  publicKey: string;
  kid: string;
  algorithm?: 'RS256' | 'EdDSA';
  previousPublicKeys?: any[];
}) {
  const algorithm = options.algorithm ?? 'EdDSA';
  const key = await importPKCS8(options.privateKey, algorithm);
  const pub = await importSPKI(options.publicKey, algorithm);
  const jwk = { ...(await exportJWK(pub)), kid: options.kid, alg: algorithm, use: 'sig' };
  const jwks = { keys: [jwk, ...(options.previousPublicKeys ?? [])] };
  const verify = verifier(createLocalJWKSet(jwks));
  return {
    jwks,
    verify,
    async mint(identity: { sub: string; tenant_id: string; roles: string[]; scopes: string[] }) {
      const now = Math.floor(Date.now() / 1000);
      const payload = claims({
        ...identity,
        iss: 'hris.internal',
        aud: 'ai-orchestrator.internal',
        iat: now,
        exp: now + 600,
        jti: randomUUID(),
      });
      return new SignJWT(payload)
        .setProtectedHeader({ alg: algorithm, kid: options.kid, typ: 'JWT' })
        .sign(key);
    },
  };
}
export function assertIdentity(
  value: unknown,
  context: Pick<UserContext, 'sub' | 'tenant_id'>,
): void {
  if (Array.isArray(value)) {
    value.forEach((v) => assertIdentity(v, context));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (k.replaceAll('_', '').toLowerCase() === 'tenantid' && v !== context.tenant_id)
      throw forbidden();
    if (['sub', 'userid'].includes(k.replaceAll('_', '').toLowerCase()) && v !== context.sub)
      throw forbidden();
    assertIdentity(v, context);
  }
}
/** Install on internal routes before handlers. Record ownership checks remain mandatory. */
export function RequireInternalServiceContext(options: {
  serviceToken: string;
  verify: (token: string) => Promise<UserContext>;
}) {
  if (options.serviceToken.length < 32)
    throw new Error('Use a service token of at least 32 characters');
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return async (request: any) => {
    const auth = request.headers.authorization;
    if (
      typeof auth !== 'string' ||
      !auth.startsWith('Bearer ') ||
      !timingSafeEqual(digest(auth.slice(7)), digest(options.serviceToken))
    )
      throw unauthorized();
    const raw = request.headers['x-user-context'];
    if (typeof raw !== 'string') throw unauthorized();
    const context = await options.verify(raw);
    for (const value of [request.params, request.query, request.body])
      assertIdentity(value, context);
    request.userContext = context;
  };
}
