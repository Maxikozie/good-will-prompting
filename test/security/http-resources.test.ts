import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { LIMITS } from '../../packages/brain/src/security/limits';

test('HTTP rejects unknown fields and oversized bodies while demo answers still work', { timeout: 30_000 }, async () => {
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const dir = mkdtempSync(join(tmpdir(), 'http-resource-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/api/server.ts', '--prod'], {
    // ANTHROPIC_BASE_URL: regression, a third-party vendor variable must not stop the API from starting.
    cwd: process.cwd(), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TRUSTLAYER_VAULT_DIR: dir, ANTHROPIC_BASE_URL: 'https://proxy.example' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; child.stdout.on('data', (b) => { logs += b; }); child.stderr.on('data', (b) => { logs += b; });
  const base = `http://127.0.0.1:${port}/api`;
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) throw new Error(`API exited: ${logs}`);
      try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, logs);
    // Regression: the Ask view's first call loads the committed existing-assistant fixtures through the strict schema.
    assert.equal((await fetch(`${base}/assistant?q=${encodeURIComponent('Sunday overtime premium in Belgium?')}`)).status, 200);
    const post =(body: unknown) => fetch(`${base}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ question: 'Sunday overtime in Belgium?' })).status, 200);
    for (const body of [{ question: 'leave', injected: true }, { question: 'x'.repeat(LIMITS.questionChars + 1) }]) {
      const response = await post(body); assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'Invalid input');
    }
    const tooLarge = await post({ question: 'x'.repeat(LIMITS.jsonBodyBytes) });
    assert.equal(tooLarge.status, 413); assert.equal((await tooLarge.json()).error, 'Request too large');
    assert.equal((await post({ question: 'Sunday overtime in Belgium?' })).status, 200);
  } finally {
    const stopped = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
    child.kill('SIGTERM'); await stopped;
    rmSync(dir, { recursive: true, force: true });
  }
});
