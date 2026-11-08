import { generateKeyPairSync, randomBytes, createPublicKey } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
const dir = resolve('.local/bridge');
await mkdir(dir, { recursive: true, mode: 0o700 });
let privateKey;
try {
  privateKey = await readFile(dir + '/private.pem');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const keys = generateKeyPairSync('ed25519');
  privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(dir + '/private.pem', privateKey, { mode: 0o600, flag: 'wx' });
}
try {
  await readFile(dir + '/public.pem');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await writeFile(
    dir + '/public.pem',
    createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }),
    { mode: 0o644, flag: 'wx' },
  );
}
let env = await readFile('.env', 'utf8');
const current = parse(env);
const defaults = {
  MCP_BRIDGE_ENABLED: 'true',
  BRIDGE_URL: 'http://127.0.0.1:4010',
  BRIDGE_PRIVATE_KEY_PATH: dir + '/private.pem',
  BRIDGE_PUBLIC_KEY_PATH: dir + '/public.pem',
  BRIDGE_SIGNING_KID: 'ao-bridge-1',
  BRIDGE_REDIS_URL: 'redis://127.0.0.1:56379',
  BRIDGE_DATABASE_URL: current.DATABASE_URL ?? '',
  BRIDGE_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
};
for (const [key, value] of Object.entries(defaults)) {
  if (current[key]?.trim()) continue;
  // Fill blank template values as well as missing settings. Never rotate an existing secret.
  const line = new RegExp('^' + key + '=.*$', 'm');
  if (line.test(env)) env = env.replace(line, () => `${key}=${value}`);
  else env += `\n${key}=${value}`;
}
await writeFile('.env', env + '\n', { mode: 0o600 });
console.log(
  'Local bridge keys and missing/blank environment settings configured. Existing values retained; no secret values printed. Redis must run without persistence on 127.0.0.1:56379.',
);
