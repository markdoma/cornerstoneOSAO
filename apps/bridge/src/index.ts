import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createBridgeServer } from './server.js';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
for (const key of [
  'BRIDGE_DATABASE_URL',
  'BRIDGE_REDIS_URL',
  'BRIDGE_ENCRYPTION_KEY',
  'BRIDGE_PUBLIC_KEY_PATH',
])
  if (!process.env[key]) throw new Error(`Configure ${key}`);
const app = await createBridgeServer({
  databaseUrl: process.env.BRIDGE_DATABASE_URL!,
  redisUrl: process.env.BRIDGE_REDIS_URL!,
  encryptionKey: process.env.BRIDGE_ENCRYPTION_KEY!,
  publicKeyPath: process.env.BRIDGE_PUBLIC_KEY_PATH!,
  kid: process.env.BRIDGE_SIGNING_KID,
  allowedOrigin: process.env.BRIDGE_ALLOWED_ORIGIN,
  allowedHosts: (process.env.BRIDGE_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,bridge').split(','),
});
await app.listen({
  port: Number(process.env.BRIDGE_PORT ?? 4010),
  host: process.env.BRIDGE_HOST ?? '127.0.0.1',
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
console.log('Managed MCP bridge listening');
