import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFile, importSpecifiers, scanBoundary } from './helpers/boundary';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const at = (p: string) => path.join(SRC, p);

describe('importSpecifiers', () => {
  it('finds static, re-export, side-effect, dynamic and require imports', () => {
    const src = `
      import a from '../reference/x';
      import { b } from "../x";
      export * from '../pipeline/y';
      import '../side-effect';
      const c = await import('../dyn');
      const d = require('../req');
    `;
    expect(importSpecifiers(src)).toEqual(['../reference/x', '../x', '../pipeline/y', '../side-effect', '../dyn', '../req']);
  });

  it('ignores imports that only appear in comments', () => {
    const src = `// import x from '../reference/x'\n/* import y from '../reference/y' */\nimport z from '../domain';`;
    expect(importSpecifiers(src)).toEqual(['../domain']);
  });
});

describe('checkFile', () => {
  it('flags evidence → reference and evidence → pipeline', () => {
    const v = checkFile(SRC, at('evidence/a.ts'), `import r from '../reference/r';\nimport p from '../pipeline';`);
    expect(v.map((x) => x.to)).toEqual(['reference', 'pipeline']);
  });

  it('flags reference → evidence, including dynamic import and deep relative paths', () => {
    const v = checkFile(SRC, at('reference/sub/a.ts'), `const m = await import('../../evidence/e');`);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ from: 'reference', to: 'evidence' });
  });

  it('flags src-rooted specifiers', () => {
    expect(checkFile(SRC, at('evidence/a.ts'), `import r from 'src/reference/r';`)).toHaveLength(1);
    expect(checkFile(SRC, at('reference/a.ts'), `import r from '@/evidence/r';`)).toHaveLength(1);
  });

  it('allows domain, same-corpus and package imports', () => {
    const src = `import { z } from 'zod';\nimport d from '../domain';\nimport s from './sibling';\nimport up from '../evidence/other';`;
    expect(checkFile(SRC, at('evidence/a.ts'), src)).toEqual([]);
  });

  it('does not restrict pipeline or domain (they see both corpora)', () => {
    expect(checkFile(SRC, at('pipeline/a.ts'), `import e from '../evidence/e';\nimport r from '../reference/r';`)).toEqual([]);
    expect(checkFile(SRC, at('domain/a.ts'), `import e from '../evidence/e';`)).toEqual([]);
  });
});

describe('scanBoundary', () => {
  it('finds a planted violation on disk', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-boundary-'));
    try {
      fs.mkdirSync(path.join(tmp, 'evidence'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'reference'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'evidence', 'bad.ts'), `import { x } from '../reference/x';\n`);
      fs.writeFileSync(path.join(tmp, 'reference', 'ok.ts'), `import { z } from 'zod';\n`);
      const v = scanBoundary(tmp);
      expect(v).toHaveLength(1);
      expect(path.basename(v[0]!.file)).toBe('bad.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the real src/evidence and src/reference have no cross imports', () => {
    expect(scanBoundary(SRC)).toEqual([]);
  });
});
