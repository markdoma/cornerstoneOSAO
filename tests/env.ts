process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://orchestrator@127.0.0.1:55432/orchestrator_test';
process.env.CREDENTIAL_KEY = 'a'.repeat(64);
process.env.OPENAI_MODELS = 'test-model';
process.env.WEB_ORIGIN = process.env.TEST_WEB_ORIGIN ?? 'http://localhost:3000';
process.env.WIDGET_ORIGIN = process.env.TEST_WIDGET_ORIGIN ?? 'http://localhost:4000';
process.env.ALLOW_LOCAL_DEMO_API = process.env.TEST_LOCAL_API ?? 'http://127.0.0.1:3002/api';
(process.env as Record<string, string>).NODE_ENV = 'test';

process.env.SMTP_URL = 'smtp://127.0.0.1:1026';

// Compatibility suites intentionally exercise historical direct deployments.
process.env.LEGACY_DIRECT_SETUP_ENABLED = 'true';
