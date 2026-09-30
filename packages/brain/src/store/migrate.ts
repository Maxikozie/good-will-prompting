import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db';
import { assertAllowedDir, isSafeFileName, resolveInside } from '../security/input';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Apply every migrations/NNN_*.sql not yet applied, in filename order, one transaction each. Idempotent. Returns applied names. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS public._brain_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM public._brain_migrations')).rows.map((r) => r.name));
  const base = assertAllowedDir(dir);
  const files = fs.readdirSync(base).filter((f) => /^\d+_.+\.sql$/.test(f) && isSafeFileName(f, '.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(resolveInside(base, f), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO public._brain_migrations (name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}
