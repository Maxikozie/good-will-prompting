import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PathError, resolveInside } from '../../packages/brain/src/security/input';

// Regression: Aikido "Potential file inclusion attack via reading file" in src/core (vault + data/mock readers).
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'trustlayer-paths-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'trustlayer-paths-outside-'));
process.env.TRUSTLAYER_VAULT_DIR = vault;
const { MOCK_DIR, WIKI_DIR, META_DIR } = await import('../../src/core/util');
const { ensureVaultDirs, getPage, listPages, loadTasks } = await import('../../src/core/vault');
const { existingAssistant } = await import('../../src/core/assistant');
after(() => {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('data/mock reads stay inside MOCK_DIR; legitimate fixtures still load', () => {
  assert.ok(fs.existsSync(resolveInside(MOCK_DIR, 'internal', 'people.json')));
  assert.throws(() => resolveInside(MOCK_DIR, '..', '..', '.env'), PathError);
  assert.throws(() => resolveInside(MOCK_DIR, '../.env'), PathError);
  assert.throws(() => resolveInside(MOCK_DIR, path.resolve(MOCK_DIR, '..', '.env')), PathError);
  assert.ok(existingAssistant('Sunday overtime premium Belgium').assistant);
});

test('vault: a symlink planted in wiki/ or .meta/ cannot redirect reads outside the vault', (t) => {
  ensureVaultDirs();
  fs.writeFileSync(path.join(outside, 'secret.md'), '---\nid: leak\n---\nsecret\n');
  fs.writeFileSync(path.join(outside, 'tasks.json'), '[]');
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(WIKI_DIR, 'leak.md'), 'file');
    fs.symlinkSync(path.join(outside, 'tasks.json'), path.join(META_DIR, 'tasks.json'), 'file');
  } catch (err) {
    t.skip(`file symlinks not permitted here: ${(err as Error).message}`);
    return;
  }
  assert.throws(() => listPages(), PathError);
  assert.throws(() => getPage('leak'), PathError);
  assert.throws(() => loadTasks(), PathError);
  assert.equal(getPage('../leak'), null);
});
