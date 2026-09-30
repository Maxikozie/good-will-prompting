import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_FIXTURE_DIR } from '../../src/llm';
import { buildAuthoredFixtures } from './demo-extraction';

// npm run author-fixtures: (re)write the hand-authored demo fixtures into test/fixtures/llm.
// Only overwrites files it owns (model "hand-authored"); real recordings from `npm run brain:record` are left alone.
let written = 0;
let kept = 0;
for (const { file, fixture } of buildAuthoredFixtures()) {
  const target = path.join(DEFAULT_FIXTURE_DIR, file);
  if (fs.existsSync(target)) {
    const existing = JSON.parse(fs.readFileSync(target, 'utf8')) as { model?: string };
    if (existing.model !== 'hand-authored') {
      kept++;
      continue;
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`);
  written++;
}
console.error(`[author-fixtures] wrote ${written}, kept ${kept} real recordings, dir ${DEFAULT_FIXTURE_DIR}`);
