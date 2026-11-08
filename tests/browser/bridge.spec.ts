import { readFile } from 'node:fs/promises';
import { strFromU8, unzipSync } from 'fflate';
import { test, expect } from '@playwright/test';
test('owner configures MCP bridge and employee confirms real API changes', async ({
  page,
  request,
}) => {
  const fixture = await (await request.get('http://127.0.0.1:4100/test/fixture')).json();
  await page.goto('/');
  await page.getByLabel('Email address').fill(fixture.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'API connections', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'MCP Bridges', exact: true }).click();
  await page.getByRole('button', { name: 'Set up bridge', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const demo = dialog.getByRole('checkbox', { name: 'Use demo app settings' });
  const apiBase = dialog.getByLabel(/^API base URL/);
  const origins = dialog.getByLabel(/^Allowed application origins/);
  await expect(demo).not.toBeChecked();
  await expect(apiBase).toHaveValue('');
  await expect(origins).toHaveValue('');
  await apiBase.fill('http://127.0.0.1:3102/api');
  await demo.check();
  await expect(apiBase).toHaveValue('http://127.0.0.1:3003/api');
  await expect(origins).toHaveValue('http://localhost:3003');
  await dialog.getByRole('combobox', { name: /^Demo app/ }).selectOption('Taskboard');
  await expect(apiBase).toHaveValue('http://127.0.0.1:3002/api');
  await expect(origins).toHaveValue('http://localhost:3002');
  await demo.uncheck();
  await expect(apiBase).toHaveValue('http://127.0.0.1:3102/api');
  await expect(origins).toHaveValue('');
  await dialog.getByLabel('Application name', { exact: true }).fill('Browser Taskboard MCP');
  await dialog.getByLabel(/^External tenant ID/).fill(fixture.tenantId);
  await origins.fill('http://localhost:3102');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog
    .getByPlaceholder('Paste a specification or upload a file')
    .fill(JSON.stringify(fixture.spec));
  await dialog.getByRole('button', { name: 'List operations' }).click();
  const checks = dialog.locator('.import-list input[type=checkbox]');
  await expect(checks).toHaveCount(5);
  for (let i = 0; i < 5; i++) await checks.nth(i).check();
  await dialog.getByRole('button', { name: 'Review selected operations' }).click();
  await dialog.getByLabel('Enable create_task', { exact: true }).check();
  await dialog.getByLabel('Enable list_tasks', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    dialog.getByText('One-time server connection required.', { exact: false }),
  ).toBeVisible();
  await dialog.getByLabel('Host session endpoint', { exact: true }).fill('/api/ao/session');
  await dialog.getByText('Preview backend connectors', { exact: true }).click();
  await expect(dialog.getByRole('tablist', { name: 'Backend language' })).toBeVisible();
  for (const name of [
    'Node.js / TypeScript',
    'C# / .NET',
    'Python',
    'PHP',
    'Go',
    'Java',
    'HTTP / Other',
  ]) {
    await dialog.getByRole('tab', { name, exact: true }).click();
    const code = dialog.getByRole('tabpanel').locator('pre.connector-source');
    await expect(code).toContainText('/v1/widget-sessions');
    await expect(code).not.toContainText("from './relay-server.mjs'");
    await expect(dialog.getByRole('button', { name: 'Copy code', exact: true })).toBeEnabled();
  }
  await dialog.getByRole('tab', { name: 'C# / .NET', exact: true }).click();
  await page.screenshot({ path: 'test-results/host-connectors-desktop.png', fullPage: true });
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download AoConnector.cs', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('AoConnector.cs');
  await dialog.getByRole('tab', { name: 'C# / .NET', exact: true }).press('ArrowRight');
  await expect(dialog.getByRole('tab', { name: 'Python', exact: true })).toBeFocused();
  await expect(dialog.getByRole('tab', { name: 'Python', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await dialog.getByRole('tab', { name: 'Node.js / TypeScript', exact: true }).click();

  await expect(
    dialog.getByText('Saving this path does not create or verify an endpoint', { exact: false }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByRole('button', { name: 'Validate bridge configuration' }).click();
  await expect(dialog.getByText('MCP 2026-07-28:', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await dialog.getByRole('button', { name: 'Publish reviewed bridge' }).click();
  await dialog.getByLabel('Agent name', { exact: true }).fill('Browser MCP assistant');
  await dialog.getByRole('button', { name: 'Create agent, publish and deploy' }).click();
  await expect(
    dialog.getByText('Server integration key — shown once', { exact: true }),
  ).toBeVisible();
  const integrationKey = await dialog.locator('.secret-box > code').innerText();
  await dialog.getByText('View public embed script', { exact: true }).click();
  const snippet = await dialog.getByLabel('Public embed script', { exact: true }).innerText();
  expect(snippet).toContain('data-session-endpoint="/api/ao/session"');
  const deploymentId = snippet.match(/data-deployment="([^"]+)"/)![1];
  await dialog.getByRole('tab', { name: 'C# / .NET', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Download install kit' })).toBeEnabled();
  await expect(dialog.getByLabel('Host environment settings', { exact: true })).toBeHidden();
  const kitDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download install kit', exact: true }).click();
  const kit = await kitDownload;
  expect(kit.suggestedFilename()).toBe('ao-dotnet-install.zip');
  const files = unzipSync(await readFile((await kit.path())!));
  expect(Object.keys(files).sort()).toEqual([
    '.env.ao.example',
    'AoConnector.cs',
    'README.md',
    'Widget.html',
  ]);
  const settings = strFromU8(files['.env.ao.example']);
  expect(settings).toContain(`AO_TENANT_ID="${fixture.tenantId}"`);
  expect(settings).toContain(`AO_DEPLOYMENT_ID="${deploymentId}"`);
  expect(settings).toContain('AO_APPLICATION_ORIGIN="http://localhost:3102"');
  expect(settings).toMatch(/^AO_INTEGRATION_KEY=$/m);
  expect(strFromU8(files['AoConnector.cs'])).toContain('MapAoAssistant');
  expect(strFromU8(files['Widget.html']).trim()).toBe(snippet);
  for (const file of Object.values(files))
    expect(strFromU8(file).includes(integrationKey)).toBe(false);
  await dialog.getByRole('tab', { name: 'Node.js / TypeScript', exact: true }).click();
  const nodeDownload = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download install kit', exact: true }).click();
  const nodeFiles = unzipSync(await readFile((await (await nodeDownload).path())!));
  expect(strFromU8(nodeFiles['route.js']).trim()).toBe(
    "export { POST } from './ao-connector.mjs';",
  );
  expect(strFromU8(nodeFiles['README.md'])).toContain('`POST /api/ao/session`');
  for (const file of Object.values(nodeFiles))
    expect(strFromU8(file).includes(integrationKey)).toBe(false);
  await request.post('http://127.0.0.1:4100/test/connect', {
    data: { deploymentId, integrationKey },
  });
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Deployments', exact: true }).click();
  await page.getByRole('button', { name: 'Get embed code', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Download install kit', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('dialog')
    .getByText('View or copy individual files', { exact: true })
    .click();
  await expect(
    page.getByRole('dialog').getByLabel('Host environment settings', { exact: true }),
  ).toContainText(`AO_TENANT_ID="${fixture.tenantId}"`);
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Copy server settings with key' }),
  ).toHaveCount(0);
  await page.getByRole('dialog').getByText('View public embed script', { exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Public embed script')).toContainText(
    'data-session-endpoint="/api/ao/session"',
  );
  await page.goto('http://localhost:3102');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in as Alice' }).click();
  await expect
    .poll(async () => (await request.get('http://localhost:3102/assistant/session')).status())
    .toBe(404);
  await expect(page.locator('iframe')).toHaveCount(1);
  const widget = page.frameLocator('iframe');
  await widget.getByRole('button', { name: 'Open Browser MCP assistant' }).click();
  await widget.getByLabel('Message', { exact: true }).fill('Create a task');
  await widget.getByRole('button', { name: 'Send message' }).click();
  await expect(widget.getByRole('button', { name: 'Confirm action' })).toBeVisible();
  await expect(page.getByText('Browser MCP task')).toHaveCount(0);
  await widget.getByRole('button', { name: 'Confirm action' }).click();
  await expect(page.getByText('Browser MCP task')).toBeVisible();
  await widget.getByText('Test permitted API tools', { exact: true }).click();
  await expect(widget.getByLabel('Test operation')).toBeVisible();
  await page.screenshot({ path: 'test-results/mcp-bridge-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
});
test('setup is keyboard accessible on a mobile viewport and reports unsupported schemas', async ({
  page,
  request,
}) => {
  const fixture = await (await request.get('http://127.0.0.1:4100/test/fixture')).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Email address').fill(fixture.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'MCP Bridges', exact: true }).click();
  await page.getByRole('button', { name: 'Set up bridge', exact: true }).click();
  const d = page.getByRole('dialog');
  await page.keyboard.press('Tab');
  await expect(d.locator(':focus')).toHaveCount(1);
  await d.getByRole('button', { name: '2. API definition', exact: true }).click();
  const spec = {
    openapi: '3.0.3',
    paths: {
      '/bad': {
        post: {
          operationId: 'bad',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { field: { type: 'string', nullable: true } },
                },
              },
            },
          },
          responses: { 200: { description: 'OK' } },
        },
      },
    },
  };
  await d.getByPlaceholder('Paste a specification or upload a file').fill(JSON.stringify(spec));
  await d.getByRole('button', { name: 'List operations' }).click();
  await d.locator('.import-list input').check();
  await d.getByRole('button', { name: 'Review selected operations' }).click();
  await expect(d.getByRole('alert')).toContainText('nullable');
  await expect(d).toBeVisible();
  await page.screenshot({ path: 'test-results/mcp-bridge-mobile.png', fullPage: true });
  await d.getByRole('button', { name: '4. Authentication', exact: true }).click();
  await d.getByText('Preview backend connectors', { exact: true }).click();
  await d.getByRole('tab', { name: 'C# / .NET', exact: true }).click();
  await expect(d.getByRole('tabpanel').locator('pre.connector-source')).toContainText(
    'MapAoAssistant',
  );
  await d.getByRole('tab', { name: 'C# / .NET', exact: true }).press('ArrowRight');
  await expect(d.getByRole('tab', { name: 'Python', exact: true })).toBeFocused();
  expect(await d.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBeTruthy();
  await page.screenshot({ path: 'test-results/host-connectors-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(d).toHaveCount(0);
});

test('large API inventory is searchable, paginated and capped at 40 reviewed operations', async ({
  page,
  request,
}) => {
  const fixture = await (await request.get('http://127.0.0.1:4100/test/fixture')).json();
  await page.goto('/');
  await page.getByLabel('Email address').fill(fixture.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'MCP Bridges', exact: true }).click();
  await page.getByRole('button', { name: 'Set up bridge', exact: true }).click();
  const d = page.getByRole('dialog');
  await d.getByRole('button', { name: '2. API definition', exact: true }).click();
  const spec = {
    openapi: '3.0.3',
    info: { title: 'Large API', version: '1', description: 'a'.repeat(1024 * 1024) },
    paths: Object.fromEntries(
      Array.from({ length: 45 }, (_, i) => [
        `/record-${i}`,
        { get: { operationId: `read_record_${i}`, responses: { '200': { description: 'OK' } } } },
      ]),
    ),
  };
  await d.locator('input[type=file]').setInputFiles({
    name: 'large-api.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(spec)),
  });
  await d.getByRole('button', { name: 'List operations' }).click();
  const checks = d.locator('.import-list input[type=checkbox]');
  await expect(checks).toHaveCount(10);
  await d.getByLabel('Search API operations').fill('/record-44');
  await expect(checks).toHaveCount(1);
  await d.getByLabel('Search API operations').fill('');
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    await expect(checks).toHaveCount(10);
    for (let i = 0; i < 10; i++) await checks.nth(i).check();
    await d.getByRole('button', { name: 'Next page', exact: true }).click();
  }
  await expect(d.getByText('40/40 selected · 45 matches', { exact: true })).toBeVisible();
  await expect(checks).toHaveCount(5);
  for (let i = 0; i < 5; i++) await expect(checks.nth(i)).toBeDisabled();
  await d.getByRole('button', { name: 'Review selected operations' }).click();
  await expect(d.locator('input[type=checkbox][aria-label^="Enable "]')).toHaveCount(40);
});
