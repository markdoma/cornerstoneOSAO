import { createApp, cleanup } from './server.js';
import { config } from './config.js';
import { db } from './db.js';
const app = await createApp();
await cleanup();
const timer = setInterval(
  () => cleanup().catch(() => console.error('Session cleanup failed')),
  30000,
);
timer.unref();
for (const sig of ['SIGINT', 'SIGTERM'])
  process.on(sig, async () => {
    clearInterval(timer);
    await app.close();
    await db.$disconnect();
    process.exit(0);
  });
await app.listen({ port: config.API_PORT, host: '0.0.0.0' });
console.log(`CornerstoneLabs AO API listening on ${config.API_PORT}`);
