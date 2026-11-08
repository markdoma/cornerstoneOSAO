import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });
import { z } from 'zod';
const env = z
  .object({
    LEGACY_DIRECT_SETUP_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    MCP_BRIDGE_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    BRIDGE_URL: z.string().url().default('http://127.0.0.1:4010'),
    BRIDGE_PRIVATE_KEY_PATH: z.string().optional(),
    BRIDGE_SIGNING_KID: z.string().default('ao-bridge-1'),
    FIRST_PARTY_JWKS_URL: z.string().url().optional(),
    FIRST_PARTY_TENANT_ORGS: z.string().default('{}'),
    HRIS_INTERNAL_API_BASE_URL: z.string().url().optional(),
    AO_SERVICE_TOKEN: z.string().min(32).optional(),
    DATABASE_URL: z.string().min(1),
    CREDENTIAL_KEY: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/, 'CREDENTIAL_KEY must contain 32 random bytes in hex'),
    API_PORT: z.coerce.number().default(4000),
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    WIDGET_ORIGIN: z.string().url().default('http://localhost:4000'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODELS: z.string().default('gpt-4.1-mini'),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default('CornerstoneLabs AO <no-reply@localhost>'),
    ALLOW_LOCAL_DEMO_API: z.string().optional(),
    NODE_ENV: z.string().default('development'),
  })
  .parse(process.env);
if (env.NODE_ENV === 'production' && env.ALLOW_LOCAL_DEMO_API)
  throw new Error('Local demo API exception is forbidden in production');
if (
  env.NODE_ENV === 'production' &&
  [env.WEB_ORIGIN, env.WIDGET_ORIGIN].some((x) => !x.startsWith('https://'))
)
  throw new Error('Production origins must use HTTPS');
export const config = {
  ...env,
  models: env.OPENAI_MODELS.split(',')
    .map((x) => x.trim())
    .filter(Boolean),
};

if (env.FIRST_PARTY_JWKS_URL) {
  if (!env.HRIS_INTERNAL_API_BASE_URL || !env.AO_SERVICE_TOKEN)
    throw new Error('First-party mode requires HRIS_INTERNAL_API_BASE_URL and AO_SERVICE_TOKEN');
  const mapping = JSON.parse(env.FIRST_PARTY_TENANT_ORGS);
  if (
    !mapping ||
    Array.isArray(mapping) ||
    typeof mapping !== 'object' ||
    !Object.keys(mapping).length ||
    Object.values(mapping).some((v) => typeof v !== 'string' || !v) ||
    new Set(Object.values(mapping)).size !== Object.keys(mapping).length
  )
    throw new Error('Configure trusted tenant-to-organization mappings');
}
