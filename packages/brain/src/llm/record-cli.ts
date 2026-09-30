import fs from 'node:fs';
import path from 'node:path';
import { createProvider, DEFAULT_FIXTURE_DIR } from './provider';
import { recordDemo } from './record';
import { LLMError } from './errors';

// npm run brain:record [-- --force]
// Runs the REAL provider (BRAIN_LLM_PROVIDER = ollama | anthropic) over the demo seed and writes FakeProvider fixtures to
// test/fixtures/llm/. Existing fixtures are reused unless --force. Commit the result so the golden test is deterministic.
const repoEnv = path.resolve(import.meta.dirname, '..', '..', '..', '..', '.env');
if (fs.existsSync(repoEnv)) process.loadEnvFile(repoEnv);
for (const k of ['BRAIN_LLM_PROVIDER', 'OLLAMA_HOST', 'OLLAMA_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) if (process.env[k] === '') delete process.env[k];

if (process.env.BRAIN_LLM_PROVIDER === 'fake') throw new LLMError('brain:record needs a real provider (ollama or anthropic), not "fake"');

const provider = createProvider(process.env);
console.error(`[brain:record] model ${provider.modelId} → ${DEFAULT_FIXTURE_DIR}`);
const report = await recordDemo({ provider, outDir: DEFAULT_FIXTURE_DIR, force: process.argv.includes('--force'), log: (l) => console.error(`[brain:record] ${l}`) });
console.error('[brain:record] done', JSON.stringify(report));
