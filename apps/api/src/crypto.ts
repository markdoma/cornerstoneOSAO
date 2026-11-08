import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { config } from './config.js';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function encrypt(v: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(config.CREDENTIAL_KEY, 'hex'), iv);
  return Buffer.concat([iv, c.update(v), c.final(), c.getAuthTag()]).toString('base64');
}
export function decrypt(v: string) {
  const b = Buffer.from(v, 'base64');
  const c = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(config.CREDENTIAL_KEY, 'hex'),
    b.subarray(0, 12),
  );
  c.setAuthTag(b.subarray(-16));
  return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString();
}
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
export const actionDigest = (v: unknown) => hash(canonical(v));
