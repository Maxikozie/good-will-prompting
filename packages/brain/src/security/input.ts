import fs from 'node:fs';
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
