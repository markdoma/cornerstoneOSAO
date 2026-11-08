import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const source = (
  await readFile(new URL('../apps/widget/src/loader.ts', import.meta.url), 'utf8')
).replace(/^import .*\n/, '');
const js = ts
  .transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  .outputText.replace(/export \{\};?\s*$/, '');
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function environment() {
  let now = Date.now(),
    counter = 0,
    failed = false,
    frames = 0;
  const requests: any[] = [];
  const posted: any[] = [];
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const window: any = { addEventListener() {}, dispatchEvent() {} };
  const script = {
    dataset: { deployment: 'deployment', auth: 'hris-jwt' },
    src: 'https://ao.example/loader.js',
  };
  const context: any = {
    window,
    document: {
      currentScript: script,
      body: {
        append() {
          frames++;
        },
      },
      createElement() {
        return {
          style: {},
          contentWindow: {
            postMessage(data: any) {
              posted.push(data);
            },
          },
          setAttribute() {},
          addEventListener() {},
          remove() {
            frames--;
          },
        };
      },
    },
    location: { href: 'https://hris.example/dashboard', origin: 'https://hris.example' },
    URL,
    CustomEvent: class {},
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout(callback: () => void, ms: number) {
      const id = ++counter;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    fetch: async (url: string, options: any) => {
      requests.push({ url: String(url), ...options });
      if (String(url).includes('/api/internal/chat/session'))
        return {
          ok: !failed,
          json: async () => ({
            user_context_token: `token-${counter}`,
            expiresAt: new Date(now + 600000).toISOString(),
          }),
        };
      if (String(url).endsWith('/config'))
        return {
          ok: true,
          json: async () => ({
            agent: { name: 'HR' },
            theme: { template: 'floating', position: 'right' },
            expiresAt: new Date(now + 600000).toISOString(),
          }),
        };
      return { ok: true };
    },
    completedActionDetail() {
      return null;
    },
  };
  runInNewContext(js, context);
  await flush();
  await flush();
  return {
    window,
    requests,
    posted,
    timers,
    frames: () => frames,
    fail() {
      failed = true;
    },
    recover() {
      failed = false;
    },
    async refresh() {
      const timer = [...timers.entries()].find(([, t]) => t.ms === 480000);
      assert.ok(timer);
      timers.delete(timer[0]);
      now += 480000;
      timer[1].callback();
      await flush();
      await flush();
    },
  };
}
test('JWT loader uses cookie-authenticated GET and silently refreshes after eight minutes', async () => {
  const e = await environment();
  assert.equal(e.frames(), 1);
  assert.equal(e.requests[0].method, 'GET');
  assert.equal(e.requests[0].credentials, 'same-origin');
  assert.equal(e.requests[0].body, undefined);
  assert.equal(e.requests[1].headers['x-deployment-id'], 'deployment');
  await e.refresh();
  assert.equal(e.frames(), 1);
  assert.equal(e.requests.filter((r) => r.url.includes('/api/internal/chat/session')).length, 2);
  assert.ok(e.posted.at(-1).token);
  e.window.OrchestratorWidget.logout();
  assert.equal(e.frames(), 0);
  assert.equal(e.timers.size, 0);
});
test('failed background refresh removes widget without host navigation and can recover', async () => {
  const e = await environment();
  e.fail();
  await e.refresh();
  assert.equal(e.frames(), 0);
  assert.equal(e.timers.size, 0);
  e.recover();
  await e.window.OrchestratorWidget.refresh();
  await flush();
  assert.equal(e.frames(), 1);
});

test('loader adds the host CSRF meta token only to its same-origin session request', async () => {
  const calls: any[] = [];
  const execute = async (header: string, content?: string) => {
    const context: any = {
      document: {
        currentScript: {
          dataset: {
            deployment: 'dep',
            sessionEndpoint: '/custom/session',
            csrfHeader: header,
            csrfMeta: 'csrf-token',
          },
          src: 'https://ao.example/loader.js',
        },
        getElementsByTagName: () => (content ? [{ name: 'csrf-token', content }] : []),
      },
      window: { addEventListener() {} },
      location: { href: 'https://host.example/app', origin: 'https://host.example' },
      URL,
      setTimeout,
      clearTimeout,
      Date,
      fetch: async (url: any, options: any) => {
        calls.push({ url: String(url), ...options });
        return { ok: false };
      },
    };
    runInNewContext(js, context);
    await flush();
  };
  await execute('X-CSRF-TOKEN', 'host-csrf-token');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://host.example/custom/session');
  assert.equal(calls[0].headers['X-CSRF-TOKEN'], 'host-csrf-token');
  assert.equal(calls[0].credentials, 'same-origin');
  calls.length = 0;
  await execute('Authorization', 'host-csrf-token');
  await execute('X-CSRF-TOKEN');
  assert.equal(calls.length, 0, 'missing token or reserved header must fail closed');
});
