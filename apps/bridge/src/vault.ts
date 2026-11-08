import { createClient } from 'redis';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { serviceError, type BridgeGrant } from '../../../packages/bridge/src/contracts.js';
export type VaultIdentity = Pick<
  BridgeGrant,
  | 'orgId'
  | 'tenantId'
  | 'userId'
  | 'deploymentId'
  | 'versionId'
  | 'sessionId'
  | 'toolIds'
  | 'revisionIds'
>;
export function createVault(url: string, keyHex: string) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex))
    throw new Error('Configure a dedicated 32-byte bridge encryption key');
  const client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: false } });
  client.on('error', () => {});
  const key = Buffer.from(keyHex, 'hex');
  async function ready() {
    if (!client.isOpen) await client.connect();
    const settings = await client.configGet(['save', 'appendonly']);
    if (settings.save !== '' || settings.appendonly !== 'no')
      throw serviceError(503, 'Credential Redis must disable RDB and AOF persistence');
  }
  function encrypt(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
  }
  function decrypt(value: string) {
    const b = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    cipher.setAuthTag(b.subarray(-16));
    return JSON.parse(
      Buffer.concat([cipher.update(b.subarray(12, -16)), cipher.final()]).toString(),
    );
  }
  return {
    async ping() {
      await ready();
      await client.ping();
    },
    async put(identity: VaultIdentity, apiToken: string, expiresAt: number, employeeId?: string) {
      await ready();
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 300000)
        throw serviceError(400, 'Invalid credential lifetime');
      const id = randomUUID();
      await client.set(
        'ao:credential:' + id,
        encrypt({ ...identity, apiToken, expiresAt, employeeId }),
        { PX: Math.max(1, expiresAt - Date.now()) },
      );
      return id;
    },
    async get(id: string, identity: BridgeGrant) {
      await ready();
      const value = await client.get('ao:credential:' + id);
      if (!value) throw serviceError(401, 'Application session expired; refresh authentication');
      const result = decrypt(value);
      for (const field of [
        'orgId',
        'tenantId',
        'userId',
        'deploymentId',
        'versionId',
        'sessionId',
      ] as const)
        if (result[field] !== identity[field])
          throw serviceError(403, 'Credential context mismatch');
      if (
        identity.revisionIds.some((id) => !result.revisionIds.includes(id)) ||
        identity.toolIds.some((id) => !result.toolIds.includes(id))
      )
        throw serviceError(403, 'Credential connection scope mismatch');
      if (result.expiresAt <= Date.now()) throw serviceError(401, 'Application session expired');
      return result as VaultIdentity & { apiToken: string; expiresAt: number; employeeId?: string };
    },
    async revoke(id: string, identity: BridgeGrant) {
      await this.get(id, identity);
      await client.del('ao:credential:' + id);
    },
    async close() {
      if (client.isOpen) await client.quit();
    },
  };
}
