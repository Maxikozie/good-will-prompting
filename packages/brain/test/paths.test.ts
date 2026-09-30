import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathError, PROJECT_ROOT, allowedFile, assertAllowedDir, isSafeFileName, resolveInside } from '../src/security/input';
import { loadSlotTemplates, SLOTS_DIR } from '../src/rules/slots';
import { RecordingProvider } from '../src/llm/record';
import { FakeProvider, fixtureFileName, type LLMProvider } from '../src/llm';
import { loadDemo } from '../src/store/seed';

// Regression: Aikido "Potential file inclusion attack via reading file". Every file read/write is resolved inside a fixed base.

const OUTSIDE = path.parse(PROJECT_ROOT).root; // exists, contains but is never inside the repo or the temp dir
const stub: LLMProvider = { modelId: 'stub', completeJSON: async () => { throw new Error('should not be called'); } };

let base: string;
let outside: string;
beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-paths-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-paths-outside-'));
  fs.writeFileSync(path.join(base, 'ok.yaml'), 'a: 1\n');
  fs.writeFileSync(path.join(outside, 'secret.yaml'), 'secret: true\n');
  // Junctions need no admin rights on Windows; on POSIX the type is ignored.
  fs.symlinkSync(outside, path.join(base, 'link'), 'junction');
});
afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('resolveInside', () => {
  it('accepts a normal file and nested segments', () => {
    expect(resolveInside(base, 'ok.yaml')).toBe(path.join(fs.realpathSync.native(base), 'ok.yaml'));
    expect(resolveInside(base, 'sub', 'new.json')).toBe(path.join(fs.realpathSync.native(base), 'sub', 'new.json'));
  });
  it('rejects ../ traversal in any form', () => {
    for (const seg of ['..', '../x.yaml', 'a/../../x', 'a\\..\\..\\x', `..${path.sep}secret.yaml`]) {
      expect(() => resolveInside(base, seg), seg).toThrow(PathError);
    }
    expect(() => resolveInside(base, 'a', '..', '..', 'x')).toThrow(PathError);
  });
  it('rejects absolute paths, drive-relative paths and NUL bytes', () => {
    expect(() => resolveInside(base, path.join(outside, 'secret.yaml'))).toThrow(PathError);
    expect(() => resolveInside(base, '/etc/passwd')).toThrow(PathError);
    expect(() => resolveInside(base, 'C:\\Windows\\win.ini')).toThrow(PathError);
    expect(() => resolveInside(base, 'C:x')).toThrow(PathError);
    expect(() => resolveInside(base, 'ok.yaml\0.png')).toThrow(PathError);
    expect(() => resolveInside(base, '')).toThrow(PathError);
  });
  it('rejects a symlink/junction inside the base that points outside it', () => {
    expect(() => resolveInside(base, 'link', 'secret.yaml')).toThrow(PathError);
    expect(() => resolveInside(base, 'link')).toThrow(PathError);
  });
});

describe('file name allowlist and allowed roots', () => {
  it('allows plain names with the required extension only', () => {
    expect(isSafeFileName('leave.small_leave.own_marriage.yaml', '.yaml')).toBe(true);
    expect(isSafeFileName('001_init.sql', '.sql')).toBe(true);
    for (const bad of ['..', '.', 'a/b.yaml', 'a\\b.yaml', 'a b.yaml', 'x.yml', '.yaml', 'a\0.yaml', 'x'.repeat(129) + '.yaml']) {
      expect(isSafeFileName(bad, '.yaml'), bad).toBe(false);
    }
  });
  it('caller-supplied directories must be inside the repo or the temp dir', () => {
    expect(assertAllowedDir(SLOTS_DIR)).toBe(fs.realpathSync.native(SLOTS_DIR));
    expect(() => assertAllowedDir(OUTSIDE)).toThrow(PathError);
    expect(() => allowedFile(path.join(OUTSIDE, 'rules.yaml'), '.yaml')).toThrow(PathError);
    expect(() => allowedFile(path.join(base, 'ok.txt'), '.yaml')).toThrow(PathError);
  });
});

describe('loaders refuse out-of-base paths', () => {
  it('loadSlotTemplates: default dir still loads, a dir outside the project is refused', () => {
    expect(loadSlotTemplates().map((t) => t.subject)).toContain('leave.small_leave.own_marriage');
    expect(() => loadSlotTemplates(OUTSIDE)).toThrow(PathError);
    expect(() => loadSlotTemplates(path.join(SLOTS_DIR, ...Array<string>(64).fill('..')))).toThrow(PathError);
  });
  it('RecordingProvider: outDir outside the project is refused, promptIds cannot traverse', async () => {
    expect(() => new RecordingProvider(stub, OUTSIDE)).toThrow(PathError);
    const rec = new RecordingProvider(stub, base);
    await expect(rec.completeJSON({} as never, [{ role: 'user', content: 'x' }], { promptId: '../../escape', promptVersion: 'v1' } as never)).rejects.toThrow(PathError);
    expect(() => fixtureFileName('../x', 'a'.repeat(64))).toThrow(PathError);
  });
  it('FakeProvider.fromDir and loadDemo refuse a directory outside the project', () => {
    expect(() => FakeProvider.fromDir(OUTSIDE)).toThrow(PathError);
    expect(() => loadDemo(OUTSIDE)).toThrow(PathError);
    expect(loadDemo().evidence.length).toBeGreaterThan(0);
  });
});
