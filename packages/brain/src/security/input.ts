import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { LIMITS } from './limits';
import { ResourceError } from './errors';

export function boundText(text: string, max = LIMITS.documentChars): string {
  if (typeof text !== 'string' || text.length > max) throw new ResourceError(413, 'Input too large');
  return text;
}
export function readText(file: string, maxBytes = LIMITS.configBytes): string {
  const fd = fs.openSync(file, 'r');
  try {
    if (fs.fstatSync(fd).size > maxBytes) throw new ResourceError(413, 'Input too large');
    // Bound actual bytes too, even if the file grows between stat and read.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > maxBytes) throw new ResourceError(413, 'Input too large');
    return buffer.subarray(0, length).toString('utf8');
  } finally { fs.closeSync(fd); }
}
/** Iterative guard before recursive Zod schemas or stringify; rejects cycles/deep structures. */
export function boundedValue(value: unknown): void {
  const todo: [unknown, number][] = [[value, 0]];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (todo.length) {
    const [item, depth] = todo.pop()!;
    if (++nodes > LIMITS.jsonBodyBytes || depth > LIMITS.jsonDepth) throw new ResourceError(413, 'Input too large');
    if (item && typeof item === 'object') {
      if (seen.has(item)) throw new ResourceError(400, 'Invalid input');
      seen.add(item);
      for (const child of Object.values(item)) todo.push([child, depth + 1]);
    }
  }
}
export function parseJson(text: string, maxBytes = LIMITS.jsonBodyBytes): unknown {
  if (Buffer.byteLength(text) > maxBytes) throw new ResourceError(413, 'Input too large');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ResourceError(400, 'Malformed JSON'); }
  boundedValue(value);
  return value;
}
export function parseYaml(text: string): unknown {
  if (Buffer.byteLength(text) > LIMITS.configBytes) throw new ResourceError(413, 'Input too large');
  // No aliases: prevents expansion bombs and cyclic structures before schema validation.
  const value: unknown = parse(text, { maxAliasCount: 0, uniqueKeys: true });
  boundedValue(value);
  return value;
}
export function readYaml<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  return schema.parse(parseYaml(readText(file)));
}
export function readJson<S extends z.ZodType>(file: string, schema: S): z.infer<S> {
  return schema.parse(parseJson(readText(file, LIMITS.jsonBodyBytes)));
}

// ---------- path containment (file inclusion / traversal guard) ----------

/** Repo root. Brain and app data files (slots, prompts, migrations, fixtures, data/mock, vault) all live below it. */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
/** Roots a caller-supplied directory may live in: the repo, plus the OS temp dir for tests and scratch runs. */
export const ALLOWED_ROOTS: readonly string[] = [PROJECT_ROOT, os.tmpdir()];

const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

export class PathError extends Error {
  constructor(message = 'Path outside allowed directory') { super(message); this.name = 'PathError'; }
}

/** Realpath of the deepest existing ancestor + the not-yet-existing rest, so symlinks/junctions are resolved even for new files. */
function canonical(p: string): string {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(head);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

const cmp = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
const within = (base: string, target: string) => {
  const b = cmp(base);
  const t = cmp(target);
  return t === b || t.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

/**
 * Join `segments` onto `baseDir` and return the canonical path, or throw if it would leave the base. Segments may contain
 * separators (e.g. "intake/abc.json") but no NUL, no ":" (drive-relative / ADS), no absolute path and no ".." component.
 * Both base and target are realpath'd, so a symlink inside the base that points outside it is rejected too.
 */
export function resolveInside(baseDir: string, ...segments: string[]): string {
  for (const s of segments) {
    if (typeof s !== 'string' || !s || s.includes('\0') || s.includes(':') || path.isAbsolute(s) || path.win32.isAbsolute(s) || s.split(/[\\/]+/).includes('..')) {
      throw new PathError('Invalid path segment');
    }
  }
  const base = canonical(baseDir);
  const target = canonical(path.resolve(base, ...segments));
  if (!within(base, target)) throw new PathError();
  return target;
}

/** A directory handed in by a caller (`dir = DEFAULT` parameters, env overrides) must be inside one of `roots`. Returns it canonical. */
export function assertAllowedDir(dir: string, roots: readonly string[] = ALLOWED_ROOTS): string {
  if (typeof dir !== 'string' || !dir || dir.includes('\0')) throw new PathError('Invalid directory');
  const target = canonical(dir);
  if (!roots.some((r) => within(canonical(r), target))) throw new PathError('Directory outside allowed roots');
  return target;
}

/** Filename allowlist for names from readdir or ids: [A-Za-z0-9._-]{1,128}, not "." / "..", optionally with a required extension. */
export function isSafeFileName(name: string, ext?: string): boolean {
  return typeof name === 'string' && SAFE_NAME_RE.test(name) && name !== '.' && name !== '..' && (!ext || (name.endsWith(ext) && name.length > ext.length));
}
export function safeFileName(name: string, ext?: string): string {
  if (!isSafeFileName(name, ext)) throw new PathError('Invalid file name');
  return name;
}
/** A file path handed in by a caller (`file = DEFAULT` parameters): allowed directory + allowlisted name with `ext`. */
export function allowedFile(file: string, ext: string, roots: readonly string[] = ALLOWED_ROOTS): string {
  if (typeof file !== 'string' || !file) throw new PathError('Invalid file');
  return resolveInside(assertAllowedDir(path.dirname(file), roots), safeFileName(path.basename(file), ext));
}
