import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SignJWT, importPKCS8, importSPKI, jwtVerify } from 'jose';
import { grantInput, type BridgeGrant, serviceError } from './contracts.js';
export async function bridgeSigner(path: string, kid = 'ao-bridge-1') {
  const key = await importPKCS8(await readFile(path, 'utf8'), 'EdDSA');
  return (grant: BridgeGrant) =>
    new SignJWT(grant)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
      .setIssuer('cornerstonelabs-ao')
      .setAudience('cornerstonelabs-mcp-bridge')
      .setIssuedAt()
      .setExpirationTime('60s')
      .setJti(randomUUID())
      .sign(key);
}
export async function bridgeVerifier(path: string, kid = 'ao-bridge-1') {
  const key = await importSPKI(await readFile(path, 'utf8'), 'EdDSA');
  return async (raw: string) => {
    try {
      const { payload, protectedHeader } = await jwtVerify(raw, key, {
        issuer: 'cornerstonelabs-ao',
        audience: 'cornerstonelabs-mcp-bridge',
        algorithms: ['EdDSA'],
        requiredClaims: ['exp', 'iat', 'jti'],
        maxTokenAge: '60s',
      });
      if (
        protectedHeader.kid !== kid ||
        protectedHeader.typ !== 'JWT' ||
        Number(payload.exp) - Number(payload.iat) > 60
      )
        throw Error();
      return grantInput.parse(payload);
    } catch {
      throw serviceError(401, 'Invalid bridge authorization');
    }
  };
}
