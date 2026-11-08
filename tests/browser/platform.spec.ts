import { test, expect } from '@playwright/test';
async function login(page: any, request: any) {
  const fixture = await (await request.get('http://localhost:4100/test/fixture')).json();
  await page.goto('/');
  await page.getByLabel('Email address').fill(fixture.email);
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workspace overview' })).toBeVisible();
  return fixture;
}
test('owner can configure, publish, connect APIs, and generate an embed snippet', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.getByRole('button', { name: 'Create agent', exact: true }).first().click();
  await page.getByLabel('Agent name').fill('Browser helper');
  await page.getByLabel('Description', { exact: true }).fill('A new assistant');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Agents', exact: false }).first().click();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: 'Browser helper', exact: true }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Publish version' }).click();
  await expect(page.getByRole('status')).toContainText('published');
  await page.getByRole('button', { name: 'Deployments', exact: true }).click();
  await page.getByRole('button', { name: 'New deployment' }).click();
  await page.getByLabel('Deployment name').fill('Browser deployment');
  const select = page.getByLabel('Published agent version');
  await select.selectOption({ label: 'Browser helper · v1' });
  await page.getByRole('button', { name: 'Inline chat panel' }).click();
  await page.getByRole('button', { name: 'Create deployment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bring your agent to your app' })).toBeVisible();
  await expect(page.getByText('Server integration key — shown once')).toBeVisible();
  await page.getByRole('tab', { name: 'Embed widget' }).click();
  await expect(page.getByLabel('Embed snippet')).toHaveValue(/data-deployment/);
  await expect(page.getByLabel('Embed snippet')).not.toHaveValue(/data-session-endpoint/);
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('button', { name: 'API connections', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'MCP Bridges', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MCP Bridges', exact: true })).toBeVisible();
});
test('authenticated floating widget confirms writes and disappears on logout', async ({ page }) => {
  await page.goto('http://localhost:3102');
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in as Alice' }).click();
  await expect(page.locator('iframe')).toHaveCount(1);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: 'Open Task assistant' }).click();
  await expect(frame.getByRole('heading', { name: 'Task assistant' })).toBeVisible();
  await frame.getByLabel('Message', { exact: true }).fill('create a task');
  await frame.getByRole('button', { name: 'Send message' }).click();
  await expect(frame.getByRole('button', { name: 'Confirm action' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh tasks' }).click();
  await expect(page.getByText('Browser-approved task', { exact: false })).toHaveCount(0);
  await frame.getByRole('button', { name: 'Confirm action' }).click();
  await expect(frame.getByText('Your request is complete.')).toBeVisible();
  // A successful write refreshes the host automatically, without a manual refresh click.
  await expect(page.getByText('Browser-approved task', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
});
test('inline widget works on mobile and supports keyboard messaging', async ({ page, request }) => {
  const fixture = await login(page, request);
  const response = await page.request.patch(`/backend/v1/deployments/${fixture.deploymentId}`, {
    headers: { origin: 'http://localhost:3100' },
    data: {
      theme: {
        template: 'inline',
        color: '#7560e8',
        mode: 'light',
        position: 'right',
        title: 'Task assistant',
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:3102');
  await page.getByRole('button', { name: 'Sign in as Bob' }).click();
  const frame = page.frameLocator('iframe');
  await expect(frame.getByLabel('Message', { exact: true })).toBeVisible();
  await frame.getByLabel('Message', { exact: true }).fill('show my tasks');
  await frame.getByLabel('Message', { exact: true }).press('Enter');
  await expect(frame.getByText('Your request is complete.')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('iframe')).toHaveCount(0);
});
