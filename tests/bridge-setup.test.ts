import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';

test('bridge setup fills blank template settings and preserves existing keys on rerun', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ao-setup-'));
  try {
    await writeFile(
      join(dir, '.env'),
      'DATABASE_URL=postgresql://example/db\nMCP_BRIDGE_ENABLED=false\nBRIDGE_PRIVATE_KEY_PATH=\nBRIDGE_PUBLIC_KEY_PATH=\nBRIDGE_DATABASE_URL=\nBRIDGE_ENCRYPTION_KEY=\n',
    );
    const run = () =>
      execFileSync(process.execPath, [resolve('scripts/setup-bridge.mjs')], {
        cwd: dir,
        encoding: 'utf8',
      });
    const output = run();
    const first = parse(await readFile(join(dir, '.env')));
    assert.equal(first.MCP_BRIDGE_ENABLED, 'false');
    assert.equal(first.BRIDGE_DATABASE_URL, 'postgresql://example/db');
    assert.match(first.BRIDGE_ENCRYPTION_KEY, /^[a-f0-9]{64}$/);
    assert.ok(first.BRIDGE_PRIVATE_KEY_PATH);
    assert.ok(first.BRIDGE_PUBLIC_KEY_PATH);
    const key = await readFile(first.BRIDGE_PRIVATE_KEY_PATH, 'utf8');
    assert.ok(!output.includes(first.BRIDGE_ENCRYPTION_KEY));
    assert.ok(!output.includes('PRIVATE KEY'));
    run();
    const second = parse(await readFile(join(dir, '.env')));
    assert.equal(second.BRIDGE_ENCRYPTION_KEY, first.BRIDGE_ENCRYPTION_KEY);
    assert.equal(await readFile(second.BRIDGE_PRIVATE_KEY_PATH, 'utf8'), key);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
