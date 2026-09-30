import fs from 'node:fs';
import path from 'node:path';

// Import scanner for the corpus boundary. Regex based on purpose: it also sees dynamic import() and require(),
// which eslint's no-restricted-imports does not.

export interface Violation {
  file: string;
  specifier: string;
  from: string;
  to: string;
}

const FORBIDDEN: Record<string, string[]> = {
  evidence: ['reference', 'pipeline'],
  reference: ['evidence', 'pipeline'],
};

/** Every module specifier in a source file (comments stripped). */
export function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const re = /\b(?:from|import|require)\s*\(?\s*['"`]([^'"`\n]+)['"`]/g;
  return [...code.matchAll(re)].map((m) => m[1]!);
}

/** Which top-level src/ folder a file or resolved path is in ("evidence", "domain", …), or null. */
function zoneOf(srcRoot: string, abs: string): string | null {
  const rel = path.relative(srcRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep)[0] ?? null;
}

export function checkFile(srcRoot: string, file: string, source: string): Violation[] {
  const from = zoneOf(srcRoot, file);
  const banned = from ? FORBIDDEN[from] : undefined;
  if (!from || !banned) return [];
  const out: Violation[] = [];
  for (const spec of importSpecifiers(source)) {
    let target: string | null = null;
    if (spec.startsWith('.')) target = path.resolve(path.dirname(file), spec);
    else if (/^(?:src\/|@\/|~\/)/.test(spec)) target = path.resolve(srcRoot, spec.replace(/^(?:src\/|@\/|~\/)/, ''));
    if (!target) continue;
    const to = zoneOf(srcRoot, target);
    if (to && banned.includes(to)) out.push({ file, specifier: spec, from, to });
  }
  return out;
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(?:ts|tsx|js|mjs|cjs)$/.test(e.name) ? [p] : [];
  });
}

/** Scan <srcRoot>/evidence and <srcRoot>/reference for forbidden imports. */
export function scanBoundary(srcRoot: string): Violation[] {
  return ['evidence', 'reference'].flatMap((zone) =>
    walk(path.join(srcRoot, zone)).flatMap((f) => checkFile(srcRoot, f, fs.readFileSync(f, 'utf8'))),
  );
}
