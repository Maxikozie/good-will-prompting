import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { LIMITS, LimitsSchema } from '../../packages/brain/src/security/limits';
import { parseEnv } from '../../packages/brain/src/security/env';
import { parseJson, parseYaml, readText } from '../../packages/brain/src/security/input';
import { ResourceError } from '../../packages/brain/src/security/errors';
import { TokenBuckets, deadline } from '../../packages/brain/src/security/runtime';
import { withBudget, reserveModelCall } from '../../packages/brain/src/security/budget';
import { embedWithLimits } from '../../packages/brain/src/security/model';
import { SnapshotInputSchema, IntakeInputSchema, createContext, runEvidencePhase } from '../../packages/brain/src/pipeline';
import { AgentDocumentSchema } from '../../packages/brain/src/evidence/adapter';
import { WikiBatchSchema } from '../../packages/brain/src/reference/ingest';
import { normalizeValue } from '../../packages/brain/src/domain/normalize';
import { extractJson, JsonProvider } from '../../packages/brain/src/llm/json';
import { postJson } from '../../packages/brain/src/llm/http';
import { FakeProvider, FakeEmbedder } from '../../packages/brain/src/llm';
import { loadScoringConfig, SCORING_FILE } from '../../packages/brain/src/scoring/config';
import { pgliteDb, migrate, type Db } from '../../packages/brain/src/store';

const dir = mkdtempSync(join(tmpdir(), 'resource-security-'));
let db: Db;
before(async () => { db = await pgliteDb(); await migrate(db); });
after(async () => { await db?.close(); rmSync(dir, { recursive: true, force: true }); });
const isLimit = (err: unknown) => err instanceof ResourceError && err.status === 429;

test('documents, question, wiki batches and nested scope reject oversized/unknown fields', () => {
  assert.throws(() => AgentDocumentSchema.parse({ text: 'x'.repeat(LIMITS.documentChars + 1) }), z.ZodError);
  assert.throws(() => AgentDocumentSchema.parse({ id: 'doc', injected: true }), z.ZodError);
  assert.throws(() => AgentDocumentSchema.parse({ id: 'doc', metadata: { declaredScope: { country: 'BE', admin: true } } }), z.ZodError);
  assert.throws(() => SnapshotInputSchema.parse({ runId: 'run', principals: ['user:a'], documents: Array.from({ length: LIMITS.documentsPerCase + 1 }, () => ({ id: 'doc' })) }), z.ZodError);
  assert.throws(() => IntakeInputSchema.parse({ question: 'x'.repeat(LIMITS.questionChars + 1), principalId: 'user:a' }), z.ZodError);
  assert.throws(() => WikiBatchSchema.parse({ pages: Array.from({ length: LIMITS.wikiPagesPerIngest + 1 }, () => ({ id: 'w', space: 'hr', title: 'test', uri: 'urn:test', lastEditedAt: new Date().toISOString(), text: 'data' })) }), z.ZodError);
  assert.throws(() => WikiBatchSchema.parse({ pages: [], extra: 'not allowed' }), z.ZodError);
  assert.throws(() => LimitsSchema.parse({ ...LIMITS, disableAllLimits: true }), z.ZodError);
});

test('orchestrator validates ALL documents before intake/model work', async () => {
  const provider = new FakeProvider();
  await assert.rejects(runEvidencePhase(createContext({ db, llm: provider, embedder: new FakeEmbedder() }), {
    question: 'Valid question', principalId: 'user:a', documents: [{ id: 'd', text: 'x'.repeat(LIMITS.documentChars + 1) }],
  }), z.ZodError);
  assert.equal(provider.calls.length, 0);
});

test('YAML unknown keys, aliases and oversized files fail before use; environment typos cannot disable ceilings', () => {
  const file = join(dir, 'scoring.yaml');
  writeFileSync(file, readFileSync(SCORING_FILE, 'utf8') + '\nunknown_security_override: true\n');
  assert.throws(() => loadScoringConfig(file), z.ZodError);
  assert.throws(() => parseYaml('a: &a [1]\nb: [*a, *a]'));
  writeFileSync(file, 'x'.repeat(LIMITS.configBytes + 1));
  assert.throws(() => readText(file), (err) => err instanceof ResourceError && err.status === 413);
  for (const env of [{ BRAIN_LLM_TIMOUT_MS: '0' }, { BRAIN_LLM_TIMEOUT_MS: '-1' }, { BRAIN_LLM_TIMEOUT_MS: String(LIMITS.llmTimeoutMs + 1) }, { PORT: 'NaN' }]) assert.throws(() => parseEnv(env), /Invalid environment/);
  assert.equal(parseEnv({ PATH: '/normal/os/path', BRAIN_LLM_TIMEOUT_MS: '50' }).BRAIN_LLM_TIMEOUT_MS, 50);
  // Regression: vendor-prefixed variables set by other tools (Claude Code sets ANTHROPIC_BASE_URL) must not crash startup,
  // while vendor names the app reads and every app-owned prefix stay validated.
  assert.equal(parseEnv({ ANTHROPIC_BASE_URL: 'https://proxy.example', OLLAMA_NUM_PARALLEL: '2', ELEVENLABS_VOICE_ID: 'v', BRAIN_LLM_TIMEOUT_MS: '50' }).BRAIN_LLM_TIMEOUT_MS, 50);
  for (const env of [{ OLLAMA_HOST: 'not a url' }, { TRUSTLAYER_VALT_DIR: '/tmp' }]) assert.throws(() => parseEnv(env), /Invalid environment/);
  assert.throws(() => parseJson('{"a":' + '['.repeat(40) + '0' + ']'.repeat(40) + '}'), ResourceError);
});

test('per-principal per-tool token bucket denies bursts and refills using elapsed time', () => {
  let now = 0;
  const buckets = new TokenBuckets(() => now, 2, 1);
  buckets.consume('alice', 'read'); buckets.consume('alice', 'read');
  assert.throws(() => buckets.consume('alice', 'read'), isLimit);
  buckets.consume('bob', 'read'); buckets.consume('alice', 'other');
  now = 999; assert.throws(() => buckets.consume('alice', 'read'), isLimit);
  now = 1000; buckets.consume('alice', 'read');
});

test('persisted run budget is atomic across simultaneous reservations and also caps input tokens', async () => {
  await db.query('INSERT INTO brain.resource_usage(scope,key,calls,tokens) VALUES ($1,$2,$3,$4)', ['run', 'race', LIMITS.modelCallsPerRun - 1, 0]);
  const call = () => withBudget({ db, principal: 'user:race', runId: 'race' }, () => reserveModelCall(['test']));
  const results = await Promise.allSettled([call(), call()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && isLimit(r.reason)).length, 1);
  await assert.rejects(withBudget({ db, principal: 'user:tokens', runId: 'tokens' }, () => reserveModelCall(['x'.repeat(LIMITS.modelTokensPerRun + 1)])), isLimit);
});

test('principal hourly budget spans different runs; failed attempts/retries are charged', async () => {
  const principal = 'user:hour';
  await db.query('INSERT INTO brain.resource_usage(scope,key,calls,tokens) VALUES ($1,$2,$3,$4)', ['principal_hour', JSON.stringify([principal, Math.floor(Date.now() / 3_600_000)]), LIMITS.modelCallsPerPrincipalHour, 0]);
  for (const runId of ['one', 'two']) await assert.rejects(withBudget({ db, principal, runId }, () => reserveModelCall(['test'])), isLimit);
  class RetryProvider extends JsonProvider {
    readonly modelId = 'test-retry'; count = 0;
    protected async raw() { this.count++; return this.count === 1 ? '{"unknown":true}' : '{"ok":true}'; }
  }
  const provider = new RetryProvider();
  const result = await withBudget({ db, principal: 'user:retry', runId: 'retry' }, () => provider.completeJSON(z.object({ ok: z.boolean() }).strict(), [{ role: 'user', content: 'test' }], { promptId: 'test', promptVersion: '1' }));
  assert.equal(result.ok, true); assert.equal(provider.count, 2);
  const usage = await db.query<{ calls: number }>('SELECT calls FROM brain.resource_usage WHERE scope = $1 AND key = $2', ['run', 'retry']);
  assert.equal(usage.rows[0]!.calls, 2);
});

test('network deadlines abort and bound response bytes; embedding work is batched', async () => {
  let aborted = false;
  await assert.rejects(postJson((async (_url, init) => { init!.signal!.addEventListener('abort', () => { aborted = true; }); return new Promise<Response>(() => {}); }) as typeof fetch, 'https://test.invalid', {}, { timeoutMs: 15, what: 'test' }), (err) => err instanceof ResourceError && err.status === 504);
  assert.equal(aborted, true);
  await assert.rejects(postJson((async () => new Response('x'.repeat(LIMITS.modelResponseBytes + 1))) as typeof fetch, 'https://test.invalid', {}, { timeoutMs: 1000, what: 'test' }), (err) => err instanceof ResourceError && err.status === 413);
  let cancelled = false;
  await assert.rejects(deadline(() => new Promise(() => {}), 10, () => { cancelled = true; }), ResourceError);
  assert.equal(cancelled, true);
  const sizes: number[] = [];
  const vectors = await embedWithLimits({ modelId: 'test', dimensions: 2, async embed(texts) { sizes.push(texts.length); return texts.map(() => [1, 0]); } }, Array.from({ length: 65 }, () => 'test'));
  assert.deepEqual(sizes, [32, 32, 1]); assert.equal(vectors.length, 65);
});

test('adversarial ReDoS payloads are rejected or processed in under 50ms', () => {
  // Warm up the code paths before timing, not the payloads.
  normalizeValue('2 dagen'); extractJson('{"ok":true}');
  const oversized = '1,'.repeat(100_000) + '!';
  const malformedFence = '```json' + ' '.repeat(100_000) + '!';
  const start = performance.now();
  assert.throws(() => normalizeValue(oversized), ResourceError);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 50, `normalizer took ${elapsed} ms`);
  const second = performance.now();
  assert.throws(() => extractJson(malformedFence));
  assert.ok(performance.now() - second < 50, 'malformed fence took >= 50ms');
  const third = performance.now(); normalizeValue('1 '.repeat(249) + '!');
  assert.ok(performance.now() - third < 50, 'bounded normalizer took >= 50ms');
});

test('stdio transport rejects oversized frames before parsing JSON', async () => {
  const { PassThrough } = await import('node:stream');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new StdioServerTransport(input, output, { maxBufferSize: LIMITS.jsonBodyBytes });
  const error = new Promise<Error>((resolve) => { transport.onerror = resolve; });
  let messages = 0;
  transport.onmessage = () => { messages++; };
  await transport.start();
  input.write('x'.repeat(LIMITS.jsonBodyBytes + 1));
  assert.ok(await error);
  assert.equal(messages, 0);
  await transport.close();
  input.destroy(); output.destroy();
});

test('database enforces a configured statement deadline', async () => {
  const result = await db.query<{ ms: number }>("SELECT setting::integer AS ms FROM pg_settings WHERE name = 'statement_timeout'");
  assert.equal(result.rows[0]?.ms, LIMITS.dbTimeoutMs);
});

test('new adjudication YAML rejects unknown top-level and per-rule settings', async () => {
  const { loadRules, RULES_FILE } = await import('../../packages/brain/src/rules/ladder-config');
  const original = readFileSync(RULES_FILE, 'utf8');
  const file = join(dir, 'rules-invalid.yaml');
  writeFileSync(file, original + '\nignoreAcl: true\n');
  assert.throws(() => loadRules(file), z.ZodError);
  writeFileSync(file, original.replace('strongTier:', 'ignoreAcl: true\n      strongTier:'));
  assert.throws(() => loadRules(file));
});
