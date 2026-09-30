import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

// Regression (Aikido: "Express is not emitting security headers"): helmet must set the baseline headers in every mode.
async function withServer(prod: boolean, check: (base: string) => Promise<void>) {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const dir = mkdtempSync(join(tmpdir(), 'http-headers-'));
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), HOST: '127.0.0.1', TRUSTLAYER_VAULT_DIR: dir };
  delete env.NODE_ENV;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/api/server.ts', ...(prod ? ['--prod'] : [])], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', (b) => { logs += b; }); child.stderr.on('data', (b) => { logs += b; });
  const base = `http://127.0.0.1:${port}/api`;
  try {
    let ready = false;
    for (let i = 0; i < 300; i++) {
      if (child.exitCode !== null) throw new Error(`API exited: ${logs}`);
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, logs);
    await check(base);
  } finally {
    const stopped = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
    child.kill('SIGTERM'); await stopped;
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertBaseline(h: Headers) {
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.match(h.get('strict-transport-security') ?? '', /max-age=\d+/);
  assert.equal(h.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(h.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(h.get('x-powered-by'), null);
}

test('production API emits helmet security headers with the strict CSP', { timeout: 30_000 }, async () => {
  await withServer(true, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assertBaseline(res.headers);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("default-src 'self'"), csp);
    assert.ok(csp.includes("script-src 'self';"), csp);
    assert.ok(csp.includes("frame-ancestors 'none'"), csp);
    assert.ok(!csp.includes('unsafe-eval') && !/script-src[^;]*unsafe-inline/.test(csp), csp);
  });
});

test('dev API emits the same baseline headers', { timeout: 30_000 }, async () => {
  await withServer(false, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assertBaseline(res.headers);
  });
});
