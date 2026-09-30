import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './db';
import { seedDemo } from './seed';

// npm run brain:seed (repo root) or npm run seed (packages/brain). DATABASE_URL → real Postgres, otherwise embedded PGlite.
const repoEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.env');
if (fs.existsSync(repoEnv)) process.loadEnvFile(repoEnv);
for (const k of ['DATABASE_URL', 'BRAIN_PGLITE_DIR']) if (process.env[k] === '') delete process.env[k];

const db = await connect();
try {
  const r = await seedDemo(db);
  console.error(`[brain] seeded (${process.env.DATABASE_URL ? 'postgres' : 'pglite'}):`, JSON.stringify(r));
} finally {
  await db.close();
}
