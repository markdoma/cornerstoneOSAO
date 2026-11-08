import { readFile } from 'node:fs/promises';
import { createIssuer } from '../../../packages/delegation/src/index.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createHost } from './server.js';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
let firstParty;
if (process.env.HRIS_SIGNING_PRIVATE_KEY_PATH) {
  if (
    !process.env.HRIS_SIGNING_PUBLIC_KEY_PATH ||
    !process.env.AO_SERVICE_TOKEN ||
    !process.env.SAMPLE_TENANT_ID
  )
    throw new Error('Configure HRIS public key, service token and sample tenant');
  firstParty = {
    issuer: await createIssuer({
      privateKey: await readFile(process.env.HRIS_SIGNING_PRIVATE_KEY_PATH, 'utf8'),
      publicKey: await readFile(process.env.HRIS_SIGNING_PUBLIC_KEY_PATH, 'utf8'),
      kid: process.env.HRIS_SIGNING_KID ?? 'hris-1',
      algorithm: process.env.HRIS_SIGNING_ALGORITHM === 'RS256' ? 'RS256' : 'EdDSA',
    }),
    serviceToken: process.env.AO_SERVICE_TOKEN,
    tenantId: process.env.SAMPLE_TENANT_ID,
  };
}
const app = await createHost({
  firstParty,
  sessionEndpoint: process.env.SAMPLE_SESSION_ENDPOINT,
  tenantId: process.env.SAMPLE_TENANT_ID,
  apiUrl: process.env.API_URL ?? 'http://localhost:4000',
  widgetOrigin: process.env.WIDGET_ORIGIN ?? 'http://localhost:4000',
  origin: process.env.SAMPLE_ORIGIN ?? 'http://localhost:3002',
  integrationKey: process.env.SAMPLE_INTEGRATION_KEY ?? '',
  deploymentId: process.env.SAMPLE_DEPLOYMENT_ID ?? '',
  toolIds: (process.env.SAMPLE_TOOL_IDS ?? '').split(',').filter(Boolean),
});
await app.listen({ port: 3002, host: '0.0.0.0' });
console.log('Sample host listening on 3002');
