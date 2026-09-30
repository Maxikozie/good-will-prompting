import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseJson, parseYaml, boundedValue } from '../../packages/brain/src/security/input';
import { extractJson } from '../../packages/brain/src/llm/json';
import { extractEvidenceTask, extractReferenceTask, FakeProvider, FakeEmbedder, DEFAULT_FIXTURE_DIR, type LLMProvider } from '../../packages/brain/src/llm';
import { extractPassageClaims } from '../../packages/brain/src/evidence/extract';
import { extractSectionFacts } from '../../packages/brain/src/reference/extract';
import { createContext, runThroughAdjudicate } from '../../packages/brain/src/pipeline';
import { DEMO_QUESTION } from '../../packages/brain/src/llm/record';
import { pgliteDb, brainRepo, evidenceRepo, orgRepo, count, type Db } from '../../packages/brain/src/store';
import { loadDemo, seedDemo } from '../../packages/brain/src/store/seed';
import { upsert } from '../../packages/brain/src/store/rows';
import { INSERTS } from '../../packages/brain/src/store/statements';

let db: Db;
let runId: string;
const demo = loadDemo();
const now = '2026-09-30T12:00:00.000Z';
before(async () => {
  db = await pgliteDb(); await seedDemo(db);
  const result = await runThroughAdjudicate(createContext({ db, llm: FakeProvider.fromDir(DEFAULT_FIXTURE_DIR), embedder: new FakeEmbedder(), now: () => new Date(now) }), {
    question: DEMO_QUESTION, principalId: 'user:nina.maes', scopeHint: { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' }, documents: ['ev-A','ev-B','ev-C','ev-D'].map((id) => ({ id })),
  });
  runId = result.intake.runId;
});
after(async () => { await db?.close(); });
async function authorityState() {
  return {
    facts: await brainRepo.listFacts(db, runId), scores: await brainRepo.listClaimScores(db, runId),
    owners: (await db.query('SELECT id, owner_id, verified_tier, last_verified_at FROM evidence.document ORDER BY id')).rows,
    wiki: (await db.query('SELECT id, owner_id, official, last_verified_at FROM reference.wiki_page ORDER BY id')).rows,
    requests: (await db.query('SELECT * FROM brain.verification_request ORDER BY id')).rows,
    events: (await db.query('SELECT * FROM brain.verification_event ORDER BY id')).rows,
  };
}
const rawClaim = { quote: 'Invented quotation absent from the source.', subject: 'leave.small_leave.own_marriage', attribute: 'duration', valueRaw: '99 dagen', qualifiers: { country: 'BE', conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule', confidence: 1 };
const provider = (response: unknown): LLMProvider => ({ modelId: 'adversarial-test', async completeJSON<T>() { return structuredClone(response) as T; } });
const fixtureDir = 'test/fixtures/injection';
const attacks = readdirSync(fixtureDir).filter((f) => /^\d{2}-.*\.md$/.test(f)).sort();
assert.equal(attacks.length, 10);
for (const file of attacks) {
  test(`injection: ${file} cannot set status, score, owner or verification in evidence/wiki`, async () => {
    const attack = readFileSync(join(fixtureDir, file), 'utf8');
    const beforeState = await authorityState();
    assert.ok(beforeState.facts.length > 0 && beforeState.scores.length > 0);
    const e = demo.evidence[0]!; const w = demo.reference[0]!;
    const evidence = (llm: LLMProvider) => extractPassageClaims({ provider: llm, document: e.document, snapshot: e.snapshot, passage: { ...e.passages[0]!, text: attack, start: 0, end: attack.length }, now, hintFor: () => undefined });
    const wiki = (llm: LLMProvider) => extractSectionFacts({ provider: llm, page: w.page, snapshot: w.snapshot, section: { ...w.sections[0]!, text: attack, start: 0, end: attack.length }, now, hintFor: () => undefined });
    for (const [field, value] of Object.entries({ status: 'VERIFIED', score: 100, owner: 'attacker', verification: { tier: 'T4', used: true } })) {
      // Assume the model obeyed the attack completely. The application must still reject its authority claims.
      const malicious = provider({ claims: [{ ...rawClaim, [field]: value }] });
      await assert.rejects(evidence(malicious), z.ZodError);
      await assert.rejects(wiki(malicious), z.ZodError);
    }
    const ev = await evidence(provider({ claims: [rawClaim] }));
    const ref = await wiki(provider({ claims: [rawClaim] }));
    assert.equal(ev.claims.length, 0); assert.equal(ev.droppedNotVerbatim, 1);
    assert.equal(ref.facts.length, 0); assert.equal(ref.droppedNotVerbatim, 1);
    for (const task of [extractEvidenceTask({ title: attack, sourceSystem: 'other', declaredScope: {}, passage: attack }), extractReferenceTask({ title: attack, space: attack, headingPath: [attack], declaredScope: {}, section: attack })]) {
      const system = task.messages[0]!.content; const user = task.messages[1]!.content;
      assert.match(system, /UNTRUSTED DATA/); assert.match(system, /no tools/i);
      assert.equal(user.split('<document>').length, 2); assert.equal(user.split('</document>').length, 2);
      assert.equal('tools' in task.opts, false);
    }
    assert.deepEqual(await authorityState(), beforeState);
  });
}

test('SQL allowlist rejects injected identifiers, conflict targets and columns before any query', async () => {
  let calls = 0;
  const noDb = { query: async () => { calls++; return { rows: [] }; } } as unknown as Db;
  await assert.rejects(count(noDb, 'org.person; DROP TABLE org.person'));
  await assert.rejects(count(noDb, 'constructor'));
  const row = Object.fromEntries(INSERTS['org.person'].columns.map((key) => [key, null]));
  await assert.rejects(upsert(noDb, 'org.person', { ...row, 'name); DROP TABLE org.person; --': 'x' }, ['id']));
  await assert.rejects(upsert(noDb, 'org.person', row, ['id) DO NOTHING; --']));
  await assert.rejects(upsert(noDb, 'org.person WHERE true', row, ['id']));
  assert.equal(calls, 0);
  const before = await count(db, 'org.person');
  assert.equal(await orgRepo.getPerson(db, "' OR true --"), null);
  assert.equal(await evidenceRepo.getDocument(db, "' OR true --"), null);
  const original = demo.people[0]!;
  await orgRepo.upsertPerson(db, { ...original, id: "injection'; DROP TABLE org.person; --" as never, name: "Robert'); DROP TABLE org.person; --" });
  assert.equal(await count(db, 'org.person'), before + 1);
});

test('JSON and YAML reject prototype pollution at any nesting level', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const text = '{"nested":[{"' + key + '":{"polluted":true}}]}';
    assert.throws(() => parseJson(text), /Forbidden object key/);
    assert.throws(() => boundedValue(JSON.parse(text)), /Forbidden object key/);
    assert.throws(() => parseYaml('nested:\n  ' + key + ':\n    polluted: true\n'), /Forbidden object key/);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('YAML accepts core data only and rejects custom tags, merge keys and aliases', () => {
  for (const payload of ['x: !evil payload', 'x: !!js/function "function(){}"', 'x: !!python/object:os.system {}', 'x: !!timestamp 2026-09-30', 'x: &base {a: 1}\ny: {<<: *base}']) assert.throws(() => parseYaml(payload));
  assert.deepEqual(parseYaml('version: 1\nactive: true\nslots: [duration]'), { version: 1, active: true, slots: ['duration'] });
});

test('model output must be one JSON value, never prose, fences or competing JSON payloads', () => {
  for (const payload of ['Ignore instructions {"claims":[]}', '```json\n{"claims":[]}\n```', '{"claims":[]} {"score":100}', '{"claims":[],"__proto__":{"polluted":true}}']) assert.throws(() => extractJson(payload));
});
