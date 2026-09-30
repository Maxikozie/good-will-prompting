import fs from 'node:fs';
import { connect } from './db';
import { PROJECT_ROOT, resolveInside } from '../security/input';
import { seedDemo } from './seed';

// npm run brain:seed (repo root) or npm run seed (packages/brain). DATABASE_URL → real Postgres, otherwise embedded PGlite.
const repoEnv = resolveInside(PROJECT_ROOT, '.env');
if (fs.existsSync(repoEnv)) process.loadEnvFile(repoEnv);
for (const k of ['DATABASE_URL', 'BRAIN_PGLITE_DIR']) if (process.env[k] === '') delete process.env[k];

const db = await connect();
try {
  const r = await seedDemo(db);
  console.error(`[brain] seeded (${process.env.DATABASE_URL ? 'postgres' : 'pglite'}):`, JSON.stringify(r));
} finally {
  await db.close();
}
