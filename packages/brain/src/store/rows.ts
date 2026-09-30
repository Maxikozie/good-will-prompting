import type { z } from 'zod';
import { Json, Vec, type Db } from './db';

/** Persisted input is validated in production too; there is no validation bypass. */
export const PARSE_ROWS = true;

export function parseRow<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  return PARSE_ROWS ? schema.parse(value) : (value as z.infer<S>);
}

type Cell = unknown;
export type Cols = Record<string, Cell>;

/** timestamptz (Date) → ISO string. */
export function iso(v: Date | string | null | undefined): string | undefined {
  if (v === null || v === undefined) return undefined;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
export const isoReq = (v: Date | string): string => iso(v)!;
export const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);
export const json = (v: unknown) => new Json(v);
export const vec = (v: readonly number[] | undefined | null) => (v ? new Vec(v) : null);

/** Drop undefined-valued keys so optional domain fields don't appear as `undefined` in parsed objects. */
export function clean<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** Every table that upsert/count may touch. Identifiers cannot be bound as parameters, so anything else is rejected. */
export const WRITABLE_TABLES: ReadonlySet<string> = new Set([
  'org.person',
  'org.expertise',
  'evidence.document',
  'evidence.snapshot',
  'evidence.passage',
  'evidence.claim',
  'reference.wiki_page',
  'reference.wiki_snapshot',
  'reference.wiki_section',
  'reference.reference_fact',
  'brain.case_run',
  'brain.fact',
  'brain.gap',
  'brain.conflict',
  'brain.canonical',
  'brain.org_event',
  'brain.run_stage',
  'brain.claim_group',
  'brain.claim_score',
  'brain.fact_decision',
  'brain.edge',
  'brain.attribution',
  'brain.llm_cache',
]);

const COLUMN_RE = /^[a-z_][a-z0-9_]*$/;
const TABLE_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/** Validated, double-quoted column identifier. */
export function quoteColumn(name: string): string {
  if (typeof name !== 'string' || !COLUMN_RE.test(name)) throw new Error(`invalid SQL column identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

/** Validated, allowlisted, double-quoted schema.table identifier (schema and table quoted separately). */
export function quoteTable(name: string): string {
  if (typeof name !== 'string' || !TABLE_RE.test(name)) throw new Error(`invalid SQL table identifier: ${JSON.stringify(name)}`);
  if (!WRITABLE_TABLES.has(name)) throw new Error(`table not allowed: ${JSON.stringify(name)}`);
  const [schema, table] = name.split('.');
  return `"${schema}"."${table}"`;
}

/**
 * INSERT … ON CONFLICT (pk) DO UPDATE (or DO NOTHING for immutable rows). The table must be in WRITABLE_TABLES and every
 * column / pk name must be a plain lowercase identifier; all identifiers are quoted and every value is a bound parameter.
 */
export async function upsert(db: Db, table: string, row: Cols, pk: string[], mode: 'update' | 'nothing' = 'update'): Promise<void> {
  const tableSql = quoteTable(table);
  const cols = Object.keys(row);
  if (cols.length === 0) throw new Error('upsert needs at least one column');
  const q = new Map(cols.map((c) => [c, quoteColumn(c)]));
  if (pk.length === 0) throw new Error('upsert needs a primary key');
  for (const k of pk) {
    quoteColumn(k);
    if (!q.has(k)) throw new Error(`primary key column not in row: ${JSON.stringify(k)}`);
  }
  const sets = cols.filter((c) => !pk.includes(c)).map((c) => `${q.get(c)} = EXCLUDED.${q.get(c)}`);
  // immutable rows (snapshots, passages): ignore ANY conflict (primary key or the (document, content hash) unique key)
  const conflictSql = mode === 'nothing' || sets.length === 0 ? 'ON CONFLICT DO NOTHING' : `ON CONFLICT (${pk.map((k) => q.get(k)).join(', ')}) DO UPDATE SET ${sets.join(', ')}`;
  const castFor = (v: Cell) => (v instanceof Json ? '::jsonb' : v instanceof Vec ? '::vector' : '');
  const ph = cols.map((c, i) => `$${i + 1}${castFor(row[c])}`);
  await db.query(`INSERT INTO ${tableSql} (${cols.map((c) => q.get(c)).join(', ')}) VALUES (${ph.join(', ')}) ${conflictSql}`, cols.map((c) => row[c]));
}

export async function count(db: Db, table: string): Promise<number> {
  const r = await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${quoteTable(table)}`);
  return Number(r.rows[0]!.n);
}
