import { INSERTS, COUNTS } from './statements';
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

/** Resolve an exact reviewed statement; table, column set, conflict key and mode fail closed. */
export async function upsert(db: Db, table: string, row: Cols, pk: string[], mode: 'update' | 'nothing' = 'update'): Promise<void> {
  if (!Object.hasOwn(INSERTS, table)) throw new Error('Unapproved SQL table');
  const statement = INSERTS[table as keyof typeof INSERTS];
  const columns: readonly string[] = statement.columns;
  if (mode !== statement.mode || pk.join(',') !== statement.pk.join(',') || Object.keys(row).length !== columns.length || columns.some((c) => !Object.hasOwn(row, c))) {
    throw new Error('Unapproved SQL columns or conflict target');
  }
  await db.query(statement.sql, columns.map((c) => row[c]));
}

export async function count(db: Db, table: string): Promise<number> {
  if (!Object.hasOwn(COUNTS, table)) throw new Error('Unapproved SQL table');
  const r = await db.query<{ n: string | number }>(COUNTS[table as keyof typeof COUNTS]);
  return Number(r.rows[0]!.n);
}
