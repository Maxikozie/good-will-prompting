import type { z } from 'zod';
import { Json, Vec, type Db } from './db';

/** Zod-parse rows coming out of the database in dev/test (BRAIN_PARSE_ROWS=0 or NODE_ENV=production turns it off). */
export const PARSE_ROWS = process.env.BRAIN_PARSE_ROWS !== '0' && process.env.NODE_ENV !== 'production';

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

/**
 * INSERT … ON CONFLICT (pk) DO UPDATE (or DO NOTHING for immutable rows). Table and column names are static strings
 * from the repository code; every value is a bound parameter.
 */
export async function upsert(db: Db, table: string, row: Cols, pk: string[], mode: 'update' | 'nothing' = 'update'): Promise<void> {
  const cols = Object.keys(row);
  const sets = cols.filter((c) => !pk.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
  // immutable rows (snapshots, passages): ignore ANY conflict (primary key or the (document, content hash) unique key)
  const conflictSql = mode === 'nothing' || sets.length === 0 ? 'ON CONFLICT DO NOTHING' : `ON CONFLICT (${pk.join(', ')}) DO UPDATE SET ${sets.join(', ')}`;
  const castFor = (v: Cell) => (v instanceof Json ? '::jsonb' : v instanceof Vec ? '::vector' : '');
  const ph = cols.map((c, i) => `$${i + 1}${castFor(row[c])}`);
  await db.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${ph.join(', ')}) ${conflictSql}`, cols.map((c) => row[c]));
}

export async function count(db: Db, table: string): Promise<number> {
  const r = await db.query<{ n: string | number }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(r.rows[0]!.n);
}
