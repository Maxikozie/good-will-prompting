import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { claimKey, runId, type Edge, type RunId } from '../src/domain';
import { splitPassages } from '../src/evidence';
import { FakeEmbedder, FakeProvider, LLMValidationError, MissingFixtureError, DEFAULT_FIXTURE_DIR, extractEvidenceTask, intakeTask, type CompleteOpts, type LLMProvider, type Message } from '../src/llm';
import { DEMO_QUESTION } from '../src/llm/record';
import { rulesVersion } from '../src/rules';
import { createContext, extract, intake, runEvidencePhase, snapshot, type PipelineCtx } from '../src/pipeline';
import { brainRepo, count, edgeRepo, evidenceRepo, pgliteDb, type Db } from '../src/store';
import { loadDemo, seedDemo } from '../src/store/seed';
import { buildAuthoredFixtures } from './helpers/demo-extraction';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const NINA = 'user:nina.maes';
const SCOPE_HINT = { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' };
const ALL_DOCS = ['ev-A', 'ev-B', 'ev-C', 'ev-D'].map((id) => ({ id }));
const demo = loadDemo();

let db: Db;
let ctx: PipelineCtx;
let fake: FakeProvider;
const fresh = () => {
  fake = FakeProvider.fromDir(DEFAULT_FIXTURE_DIR);
  ctx = createContext({ db, llm: fake, embedder: new FakeEmbedder(), now: () => NOW });
};

beforeAll(async () => {
  db = await pgliteDb();
  await seedDemo(db);
  fresh();
});
afterAll(async () => db.close());

const claimsOf = async (docId: string) => {
  const snap = (await evidenceRepo.latestSnapshot(db, docId))!;
  return { snap, claims: await evidenceRepo.listClaimsBySnapshot(db, snap.id) };
};

describe('fixtures', () => {
  it('the committed hand-authored fixtures are up to date with the prompts (run `npm run author-fixtures` if this fails)', () => {
    const built = buildAuthoredFixtures();
    expect(built).toHaveLength(36);
    for (const { file, fixture } of built) {
      const target = path.join(DEFAULT_FIXTURE_DIR, file);
      expect(fs.existsSync(target), file).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (onDisk.model === 'hand-authored') expect(onDisk).toEqual(fixture);
    }
  });
});

describe('the demo run (A–D, asked by Nina)', () => {
  let result: Awaited<ReturnType<typeof runEvidencePhase>>;
  let RUN: RunId;

  beforeAll(async () => {
    result = await runEvidencePhase(ctx, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, documents: ALL_DOCS });
    RUN = result.intake.runId;
  });

  describe('00 intake', () => {
    it('resolves the known subject, merges the caller’s scope hint over the model’s nulls, persists the CaseRun', async () => {
      const { intent, slotTemplate } = result.intake;
      expect(intent).toMatchObject({ subject: 'leave.small_leave.own_marriage', generatedSlots: false, slotTemplateId: 'leave.small_leave.own_marriage', questionType: 'rule', scope: { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' } });
      expect(slotTemplate.slots.map((s) => s.id)).toEqual(['duration', 'eligibility', 'timing_window', 'pay_continuation', 'proof_required', 'legal_basis', 'effective_from']);
      const run = (await brainRepo.getRun(db, RUN))!;
      expect(run).toMatchObject({ question: DEMO_QUESTION, principalId: NINA, status: 'running', rulesVersion: rulesVersion(), modelIds: { llm: 'fake', embedder: 'fake-hash-768' }, startedAt: NOW.toISOString() });
      expect(run.promptVersions).toMatchObject({ intake: 'intake.v1', 'extract-evidence': 'extract-evidence.v1' });
      expect(run.intent).toEqual(intent);
    });

    it('proposes generated slots (weights ×0.8) for an unknown subject', async () => {
      const question = 'Hoeveel dagen thuiswerk mag ik per week?';
      const provider = new FakeProvider();
      const task = intakeTask(question, ctx.templates.map((t) => ({ subject: t.subject, label: t.label })));
      provider.register('intake', task.messages, {
        subject: 'telework.weekly_days', matchesKnownSubject: false, scope: { country: null }, questionType: 'amount',
        proposedSlots: [{ id: 'days_per_week', attribute: 'duration', required: true }, { id: 'approval', attribute: 'eligibility', required: false }],
      });
      const out = await intake({ ...ctx, llm: provider }, { question, principalId: NINA, runId: runId('run-generated') });
      expect(out.intent).toMatchObject({ generatedSlots: true, slotTemplateId: 'generated:telework.weekly_days', scope: { country: null } });
      expect(out.slotTemplate.slots.map((s) => [s.id, s.weight])).toEqual([['days_per_week', 0.8], ['approval', 0.4]]);
    });

    it('rejects bad input before any model call', async () => {
      const before = fake.calls.length;
      await expect(intake(ctx, { question: 'x', principalId: NINA })).rejects.toThrow();
      await expect(intake(ctx, { question: DEMO_QUESTION, principalId: NINA, extra: 1 } as never)).rejects.toThrow();
      expect(fake.calls.length).toBe(before);
    });
  });

  describe('10 snapshot', () => {
    it('snapshots the four documents with heading-aware passages (8 / 3 / 3 / 7)', async () => {
      expect(result.snapshot.documents.map((d) => [d.documentId, d.passageIds.length])).toEqual([['ev-A', 8], ['ev-B', 3], ['ev-C', 3], ['ev-D', 7]]);
      for (const d of result.snapshot.documents) {
        const snap = (await evidenceRepo.getSnapshot(db, d.snapshotId))!;
        expect(snap.contentHash).toBe(d.contentHash);
        for (const p of await evidenceRepo.listPassages(db, snap.id)) expect(snap.text.slice(p.start, p.end)).toBe(p.text);
      }
      expect((await brainRepo.getRun(db, RUN))!.evidenceSnapshotIds).toEqual(result.snapshot.documents.map((d) => d.snapshotId));
    });

    it('embeds every passage exactly once', async () => {
      for (const d of result.snapshot.documents) expect(await evidenceRepo.listPassageIdsWithoutEmbedding(db, d.snapshotId)).toEqual([]);
    });

    it('finds the D↔A duplicates: the five identical sections, and nothing involving B or C', async () => {
      const edges = (await edgeRepo.edgesByRun(db, RUN)).filter((e) => e.type === 'DUPLICATE_OF') as Extract<Edge, { type: 'DUPLICATE_OF' }>[];
      expect(edges.length).toBe(result.snapshot.duplicatePairs);
      const docOf = (passageId: string) => (passageId.startsWith('snap-ev-A') ? 'A' : passageId.startsWith('snap-ev-D') ? 'D' : passageId.startsWith('snap-ev-B') ? 'B' : 'C');
      for (const e of edges) expect(new Set([docOf(e.fromId), docOf(e.toId)])).toEqual(new Set(['A', 'D']));

      const textOf = async (id: string) => (await evidenceRepo.listPassages(db, id.split('#')[0]!)).find((p) => p.id === id)!.text;
      const exact = edges.filter((e) => e.props.method === 'exact');
      expect(exact).toHaveLength(5);
      const headings = await Promise.all(exact.map(async (e) => (await textOf(e.fromId)).match(/^## (.+)$/m)![1]));
      expect(headings.sort()).toEqual(['Bewijsstuk', 'Klein verlet bij eigen huwelijk: duur', 'Loon tijdens het verlof', 'Wie heeft recht', 'Doel en toepassingsgebied'].sort());
      for (const e of exact) {
        expect(e.props.score).toBe(1);
        expect(e.fromKind).toBe('evidence_passage');
        expect(await textOf(e.fromId)).toBe(await textOf(e.toId));
      }
      // the timing window exists only in A: no duplicate partner in D
      const timing = (await evidenceRepo.listPassages(db, result.snapshot.documents[0]!.snapshotId)).find((p) => p.text.includes('Wanneer op te nemen'))!;
      expect(edges.some((e) => e.fromId === timing.id || e.toId === timing.id)).toBe(false);
    });
  });

  describe('20 extract', () => {
    it('keeps the expected number of claims per document (A 6, B 3, C 4, D 4) and drops none', async () => {
      expect(result.extract.claimsByDocument).toEqual({ 'ev-A': 6, 'ev-B': 3, 'ev-C': 4, 'ev-D': 4 });
      expect(result.extract.claimIds).toHaveLength(17);
      const stats = (await brainRepo.listStageLogs(db, RUN)).find((s) => s.stage === '20-extract')!.stats;
      expect(stats).toMatchObject({ passages: 21, claimsReturned: 17, claimsKept: 17, droppedNotVerbatim: 0, extractionFailures: 0 });
    });

    it('no stored claim lacks a verbatim quote: the span points at exactly that text in the snapshot', async () => {
      const rows = await db.query<{ id: string }>('SELECT id FROM evidence.claim');
      expect(rows.rows).toHaveLength(17);
      for (const d of ['ev-A', 'ev-B', 'ev-C', 'ev-D']) {
        const { snap, claims } = await claimsOf(d);
        for (const c of claims) {
          expect(snap.text.slice(c.span.start, c.span.end), c.id).toBe(c.quote);
          const passage = (await evidenceRepo.listPassages(db, snap.id)).find((p) => p.id === c.passageId)!;
          expect(passage.text).toContain(c.quote);
        }
      }
    });

    it('C carries country NL on every claim; A, B, D carry BE; A and D carry PC 200 / bediende', async () => {
      for (const c of (await claimsOf('ev-C')).claims) expect(c.qualifiers.country, c.id).toBe('NL');
      for (const d of ['ev-A', 'ev-B', 'ev-D']) for (const c of (await claimsOf(d)).claims) expect(c.qualifiers.country, `${d} ${c.id}`).toBe('BE');
      for (const d of ['ev-A', 'ev-D']) for (const c of (await claimsOf(d)).claims) expect(c.qualifiers).toMatchObject({ jointCommittee: 'PC 200', employeeCategory: 'bediende' });
      for (const c of (await claimsOf('ev-B')).claims) expect(c.qualifiers.jointCommittee).toBeUndefined();
    });

    it('normalizes values with code and sets claim keys from subject, attribute and effective scope', async () => {
      const a = (await claimsOf('ev-A')).claims;
      const duration = a.find((c) => c.attribute === 'duration')!;
      expect(duration.value).toMatchObject({ type: 'number', normalized: 2, unit: 'days', raw: '2 werkdagen' });
      expect(duration.claimKey).toBe(claimKey({ subject: duration.subject, attribute: 'duration', qualifiers: { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende', product: 'hr' } }));
      expect(a.find((c) => c.attribute === 'deadline')!.value).toMatchObject({ normalized: 14, unit: 'days' });
      expect(a.find((c) => c.attribute === 'timing_window')!.value.type).toBe('text');

      const d = (await claimsOf('ev-D')).claims.find((c) => c.attribute === 'duration')!;
      expect(d.claimKey).toBe(duration.claimKey); // same subject + attribute + scope: one fact
      const b = (await claimsOf('ev-B')).claims.filter((c) => c.attribute === 'duration');
      expect(b.map((c) => c.value.normalized).sort()).toEqual([10, 3]);
      expect(b[0]!.claimKey).not.toBe(duration.claimKey); // B states no PC / category: aligned later by scope overlap, not by exact key
      const c = (await claimsOf('ev-C')).claims.find((x) => x.attribute === 'duration')!;
      expect(c.value.normalized).toBe(3);
      expect(c.claimKey).not.toBe(b[0]!.claimKey); // BE and NL never share a key, even though both say 3 days
    });

    it('keeps the injected instruction as an unverified non-rule claim, and flags B (only B) as instruction-like', async () => {
      const injected = (await claimsOf('ev-B')).claims.find((c) => c.value.normalized === 10)!;
      expect(injected).toMatchObject({ modality: 'unknown', extractionConfidence: 0.2 });
      const stats = (await brainRepo.listStageLogs(db, RUN)).find((s) => s.stage === '20-extract')!.stats as { injection: { documentId: string }[]; injectionFlaggedPassages: number };
      expect(stats.injectionFlaggedPassages).toBeGreaterThanOrEqual(1);
      expect(new Set(stats.injection.map((i) => i.documentId))).toEqual(new Set(['ev-B']));
    });

    it('never calls the model for a passage of a document the caller cannot read, and leaves no claim for it', async () => {
      expect(await count(db, 'evidence.claim')).toBe(17);
    });
  });

  describe('run log', () => {
    it('writes one completed row per stage with its counters', async () => {
      const logs = await brainRepo.listStageLogs(db, RUN);
      expect(logs.map((l) => [l.stage, l.status])).toEqual([['00-intake', 'completed'], ['10-snapshot', 'completed'], ['20-extract', 'completed']]);
      expect(logs[0]!.stats).toMatchObject({ subject: 'leave.small_leave.own_marriage', generatedSlots: false, scopeFromHint: 3, slots: 7 });
      expect(logs[1]!.stats).toMatchObject({ received: 4, unresolved: 0, aclDenied: 0, dedupedByHash: 0, documents: 4, passages: 21, embedded: 21, duplicatePairs: result.snapshot.duplicatePairs });
      expect(logs[2]!.stats).toMatchObject({ droppedNotVerbatim: 0 });
    });
  });

  describe('determinism and idempotence', () => {
    it('re-running stages 10 and 20 on the same run changes nothing (same claim ids, no duplicates)', async () => {
      const before = { claims: await count(db, 'evidence.claim'), passages: await count(db, 'evidence.passage'), snapshots: await count(db, 'evidence.snapshot'), edges: await count(db, 'brain.edge') };
      const s2 = await snapshot(ctx, { runId: RUN, principals: ['user:nina.maes', 'group:customer-service-be', 'group:all-staff'], documents: ALL_DOCS });
      const x2 = await extract(ctx, { runId: RUN, snapshotIds: s2.documents.map((d) => d.snapshotId), slotTemplate: result.intake.slotTemplate });
      expect(x2.claimIds).toEqual(result.extract.claimIds);
      expect({ claims: await count(db, 'evidence.claim'), passages: await count(db, 'evidence.passage'), snapshots: await count(db, 'evidence.snapshot'), edges: await count(db, 'brain.edge') }).toEqual(before);
      const logs = await brainRepo.listStageLogs(db, RUN);
      expect((logs.find((l) => l.stage === '10-snapshot')!.stats as { embedded: number; newSnapshots: number })).toMatchObject({ embedded: 0, newSnapshots: 0 });
    });
  });
});

describe('ACL, adapter and dedupe (10 snapshot)', () => {
  const principalsOf = (id: string) => demo.people.find((p) => p.id === id)!.principalIds as string[];

  it('drops documents the caller may not read before anything is stored or sent to the model', async () => {
    fresh();
    const res = await runEvidencePhase(ctx, { question: DEMO_QUESTION, principalId: 'user:daan.visser', scopeHint: SCOPE_HINT, documents: ALL_DOCS, runId: runId('run-acl') });
    expect(res.snapshot.documents.map((d) => d.documentId)).toEqual(['ev-C']);
    const logs = await brainRepo.listStageLogs(db, runId('run-acl'));
    expect(logs.find((l) => l.stage === '10-snapshot')!.stats).toMatchObject({ received: 4, aclDenied: 3, documents: 1 });
    const extractCalls = fake.calls.filter((c) => c.promptId === 'extract-evidence');
    expect(extractCalls).toHaveLength(3); // only C's three passages
    expect(res.extract.claimsByDocument).toEqual({ 'ev-C': 4 });
    expect((await brainRepo.getRun(db, runId('run-acl')))!.evidenceSnapshotIds).toHaveLength(1);
  });

  it('a principal with no access at all gets an empty run, not an error and not a leak', async () => {
    fresh();
    const res = await runEvidencePhase(ctx, { question: DEMO_QUESTION, principalId: 'user:nobody', principals: ['user:nobody'], documents: ALL_DOCS, runId: runId('run-none') });
    expect(res.snapshot.documents).toEqual([]);
    expect(res.extract.claimIds).toEqual([]);
    expect(fake.calls.filter((c) => c.promptId === 'extract-evidence')).toHaveLength(0);
  });

  it('dedupes identical content by hash, resolves by uri, counts unresolved payloads, and versions an edited document', async () => {
    fresh();
    const A = demo.evidence.find((e) => e.document.id === 'ev-A')!;
    const i = await intake(ctx, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, runId: runId('run-adapter') });
    const principals = principalsOf('nina.maes');

    const s1 = await snapshot(ctx, {
      runId: i.runId,
      principals,
      documents: [
        { id: 'ev-A' },
        { uri: A.document.sourceUri }, // same document by uri → same content → deduped by hash
        { text: A.snapshot.text, metadata: { title: 'copy of A', allowedPrincipals: principals } }, // same text under a new id → deduped by hash
        { id: 'does-not-exist' }, // nothing to read
      ],
    });
    expect(s1.documents.map((d) => d.documentId)).toEqual(['ev-A']);
    const stats = (await brainRepo.listStageLogs(db, i.runId)).find((l) => l.stage === '10-snapshot')!.stats;
    expect(stats).toMatchObject({ received: 4, unresolved: 1, dedupedByHash: 2, documents: 1 });

    // an edited text of a known document becomes snapshot version 2; version 1 is untouched
    const edited = `${A.snapshot.text}\n\n## Nieuw\n\nEen extra alinea met voldoende woorden om als aparte passage te tellen in deze test.`;
    const s2 = await snapshot(ctx, { runId: i.runId, principals, documents: [{ id: 'ev-A', text: edited }] });
    expect(s2.documents[0]).toMatchObject({ documentId: 'ev-A', version: 2 });
    expect(s2.documents[0]!.passageIds).toHaveLength(9);
    expect(await evidenceRepo.getSnapshot(db, A.snapshot.id)).toEqual(A.snapshot);
    expect((await evidenceRepo.latestSnapshot(db, 'ev-A'))!.version).toBe(2);
  });

  it('creates an unknown document from the payload readable only by the caller, with unknown dates never counted as verified', async () => {
    fresh();
    const i = await intake(ctx, { question: DEMO_QUESTION, principalId: NINA, runId: runId('run-newdoc') });
    const s = await snapshot(ctx, { runId: i.runId, principals: principalsOf('nina.maes'), documents: [{ uri: 'https://x.example/memo', text: '# Memo\n\nGeen land genoemd. Het verlof is 4 dagen.', metadata: { title: 'Memo' } }] });
    const doc = (await evidenceRepo.getDocument(db, s.documents[0]!.documentId))!;
    expect(doc).toMatchObject({ title: 'Memo', sourceSystem: 'other', allowedPrincipals: ['user:nina.maes'], declaredScope: {} });
    expect(doc.lastVerifiedAt).toBeUndefined();
    expect(doc.verifiedTier).toBeUndefined();
    expect(doc.lastEditedAt).toBe(NOW.toISOString());
    // another caller cannot read it
    const other = await snapshot(ctx, { runId: i.runId, principals: ['user:daan.visser'], documents: [{ id: doc.id }] });
    expect(other.documents).toEqual([]);
  });

  it('rejects invalid stage input (no documents, unknown fields, empty principals)', async () => {
    await expect(snapshot(ctx, { runId: runId('r'), principals: ['x'], documents: [] })).rejects.toThrow();
    await expect(snapshot(ctx, { runId: runId('r'), principals: [], documents: ALL_DOCS })).rejects.toThrow();
    await expect(snapshot(ctx, { runId: runId('r'), principals: ['x'], documents: [{ id: 'a', bogus: 1 } as never] })).rejects.toThrow();
    await expect(snapshot(ctx, { runId: runId('r'), principals: ['x'], documents: [{}] as never })).rejects.toThrow();
  });
});

/** Delegates to the fake, then appends a hallucinated claim to the answer for one passage. */
class Tampering implements LLMProvider {
  readonly modelId = 'tampering';
  constructor(private readonly inner: FakeProvider, private readonly marker: string) {}
  async completeJSON<T>(schema: z.ZodType<T>, messages: readonly Message[], opts: CompleteOpts<T>): Promise<T> {
    const out = (await this.inner.completeJSON(schema, messages, opts)) as { claims?: Record<string, unknown>[] };
    if (opts.promptId === 'extract-evidence' && messages.at(-1)!.content.includes(this.marker) && out.claims) {
      return schema.parse({ claims: [...out.claims, { quote: 'Dit staat nergens in het document', subject: 'leave.small_leave.own_marriage', attribute: 'duration', valueRaw: '99 dagen', qualifiers: { conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule', confidence: 1 }, { quote: 'verhoogd naar 3  werkdagen', subject: 'leave.small_leave.own_marriage', attribute: 'duration', valueRaw: '3', qualifiers: { conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule', confidence: 1 }] });
    }
    return out as T;
  }
}

describe('20 extract: drops, failures and scope flags', () => {
  it('drops claims whose quote is not verbatim (even by one space) and counts them in the run stats', async () => {
    fresh();
    const pipeline = createContext({ db, llm: new Tampering(fake, 'Wijziging bij eigen huwelijk'), embedder: new FakeEmbedder(), now: () => NOW });
    const i = await intake(pipeline, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, runId: runId('run-tamper') });
    const s = await snapshot(pipeline, { runId: i.runId, principals: ['user:nina.maes', 'group:customer-service-be', 'group:payroll-be'], documents: [{ id: 'ev-B' }] });
    const x = await extract(pipeline, { runId: i.runId, snapshotIds: s.documents.map((d) => d.snapshotId), slotTemplate: i.slotTemplate });
    expect(x.claimsByDocument).toEqual({ 'ev-B': 3 });
    const stats = (await brainRepo.listStageLogs(db, i.runId)).find((l) => l.stage === '20-extract')!.stats;
    expect(stats).toMatchObject({ claimsReturned: 5, claimsKept: 3, droppedNotVerbatim: 2 });
    const { claims } = await claimsOf('ev-B');
    expect(claims.some((c) => c.quote.includes('nergens'))).toBe(false);
    expect(claims.some((c) => c.value.normalized === 99)).toBe(false);
  });

  it('flags claims with no country anywhere as SCOPE_UNDECLARED (country null) and counts them', async () => {
    const text = '# Memo\n\nGeen land genoemd.\n\n## Duur\n\nHet klein verlet bij huwelijk bedraagt 4 dagen.\n';
    const claim = { quote: 'bedraagt 4 dagen', subject: 'leave.small_leave.own_marriage', attribute: 'duration', valueRaw: '4 dagen', qualifiers: { conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule', confidence: 0.8 };
    const provider = new FakeProvider();
    const pipeline = createContext({ db, llm: provider, embedder: new FakeEmbedder(), now: () => NOW });
    provider.register('intake', intakeTask(DEMO_QUESTION, pipeline.templates.map((t) => ({ subject: t.subject, label: t.label }))).messages, {
      subject: 'leave.small_leave.own_marriage', matchesKnownSubject: true, scope: { country: null }, questionType: 'rule', proposedSlots: [],
    });
    for (const p of splitPassages(text)) {
      const messages = extractEvidenceTask({ title: 'Memo', sourceSystem: 'other', declaredScope: {}, passage: p.text }).messages;
      provider.register('extract-evidence', messages, { claims: p.text.includes('bedraagt 4 dagen') ? [claim] : [] });
    }

    const run = await runEvidencePhase(pipeline, { question: DEMO_QUESTION, principalId: NINA, documents: [{ uri: 'https://x.example/memo2', text, metadata: { title: 'Memo' } }], runId: runId('run-undeclared') });
    expect(run.extract.claimIds).toHaveLength(1);
    const c = (await evidenceRepo.listClaimsBySnapshot(db, run.snapshot.documents[0]!.snapshotId))[0]!;
    expect(c.qualifiers.country).toBeNull();
    expect(c.value).toMatchObject({ normalized: 4, unit: 'days' });
    const stats = (await brainRepo.listStageLogs(db, runId('run-undeclared'))).find((l) => l.stage === '20-extract')!.stats;
    expect(stats).toMatchObject({ scopeUndeclared: 1, claimsKept: 1 });
  });

  it('a missing fixture aborts the stage loudly and is recorded as failed; a model that cannot produce valid JSON only costs that passage', async () => {
    fresh();
    const i = await intake(ctx, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, runId: runId('run-missing') });
    const s = await snapshot(ctx, { runId: i.runId, principals: ['user:nina.maes', 'group:customer-service-be'], documents: [{ uri: 'https://x.example/nofixture', text: '# Zonder fixture\n\n## Duur\n\nEen nieuwe tekst zonder opgenomen antwoord.', metadata: { title: 'Zonder fixture' } }] });
    const snapshotIds = s.documents.map((d) => d.snapshotId);
    await expect(extract(ctx, { runId: i.runId, snapshotIds, slotTemplate: i.slotTemplate })).rejects.toThrow(MissingFixtureError);
    const failed = (await brainRepo.listStageLogs(db, i.runId)).find((l) => l.stage === '20-extract')!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/No LLM fixture/);

    const flaky: LLMProvider = {
      modelId: 'flaky',
      async completeJSON() {
        throw new LLMValidationError('invalid after retries', 'extract-evidence', 3, 'garbage');
      },
    };
    const x = await extract({ ...ctx, llm: flaky }, { runId: i.runId, snapshotIds, slotTemplate: i.slotTemplate });
    expect(x.claimIds).toEqual([]);
    expect((await brainRepo.listStageLogs(db, i.runId)).find((l) => l.stage === '20-extract')).toMatchObject({ status: 'completed', stats: { extractionFailures: 2, claimsKept: 0 } });
  });
});
