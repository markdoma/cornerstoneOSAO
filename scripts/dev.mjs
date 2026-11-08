import concurrently from 'concurrently';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
const demoEnabled = process.env.ENABLE_DEMO_APP === 'true';
process.env.ALLOW_LOCAL_DEMO_API = demoEnabled
  ? process.env.ALLOW_LOCAL_DEMO_API || 'http://127.0.0.1:3002/api'
  : '';

const commands = [
  { name: 'api', command: 'npm run dev -w @orchestrator/api', prefixColor: 'cyan' },
  { name: 'web', command: 'npm run dev -w @orchestrator/web', prefixColor: 'magenta' },
  { name: 'widget', command: 'npm run dev -w @orchestrator/widget', prefixColor: 'green' },
  { name: 'bridge', command: 'node scripts/dev-bridge.mjs', prefixColor: 'blue' },
];

if (demoEnabled) {
  commands.push({
    name: 'host',
    command: 'npm run dev -w @orchestrator/sample-host',
    prefixColor: 'yellow',
  });
}

const { result } = concurrently(commands);
try {
  await result;
} catch {
  process.exitCode = 1;
}
