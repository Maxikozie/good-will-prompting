import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runId, type Edge, type EvidenceClaim, type Fact, type RunId } from '../src/domain';
import { FakeEmbedder, FakeProvider, DEFAULT_FIXTURE_DIR, extractEvidenceTask, intakeTask, relationTask, type Embedder } from '../src/llm';
import { DEMO_QUESTION } from '../src/llm/record';
import { splitPassages } from '../src/evidence';
import { align, createContext, extract, gaps, intake, runThroughGaps, snapshot, type PipelineCtx } from '../src/pipeline';
import { brainRepo, count, edgeRepo, evidenceRepo, pgliteDb, type Db } from '../src/store';
import { seedDemo } from '../src/store/seed';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const NINA = 'user:nina.maes';
const SCOPE_HINT = { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' };
const ALL_DOCS = ['ev-A', 'ev-B', 'ev-C', 'ev-D'].map((id) => ({ id }));

let db: Db;
let ctx: PipelineCtx;
beforeAll(async () => {
  db = await pgliteDb();
  await seedDemo(db);
  ctx = createContext({ db, llm: FakeProvider.fromDir(DEFAULT_FIXTURE_DIR), embedder: new FakeEmbedder(), now: () => NOW });
});
afterAll(async () => db.close());

const claimsByDoc = async () => {
  const out = new Map<string, EvidenceClaim[]>();
  for (const d of ['ev-A', 'ev-B', 'ev-C', 'ev-D']) out.set(d, (await evidenceRepo.listClaimsBySnapshot(db, (await evidenceRepo.latestSnapshot(db, d))!.id)));
  return out;
};

describe('the demo seed through stages 30 and 40', () => {
  let RUN: RunId;
  let res: Awaited<ReturnType<typeof runThroughGaps>>;
  let facts: Fact[];
  let edges: Edge[];
  let docs: Map<string, EvidenceClaim[]>;
  const claimOf = (docId: string, attribute: string, pick?: (c: EvidenceClaim) => boolean) => docs.get(docId)!.find((c) => c.attribute === attribute && (!pick || pick(c)))!;
  const factOf = (claimId: string) => {
    const e = edges.find((x) => x.type === 'MEMBER_OF' && x.fromId === claimId)!;
    return facts.find((f) => f.id === e.toId)!;
  };

  beforeAll(async () => {
    res = await runThroughGaps(ctx, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, documents: ALL_DOCS });
    RUN = res.intake.runId;
    facts = await brainRepo.listFacts(db, RUN);
    edges = await edgeRepo.edgesByRun(db, RUN);
    docs = await claimsByDoc();
  });

  describe('30 align', () => {
    it('yields one duration fact holding A=2, D=2 and B=3 (plus B’s injected 10), and it is about the question scope', () => {
      const a = claimOf('ev-A', 'duration');
      const f = factOf(a.id);
      expect(f).toMatchObject({ attribute: 'duration', slotId: 'duration', impact: 'high', status: 'UNKNOWN', confidence: 0, needsVerification: false, scope: { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' } });
      const members = edges.filter((e) => e.type === 'MEMBER_OF' && e.toId === f.id).map((e) => e.fromId).sort();
      expect(members).toEqual([a, claimOf('ev-D', 'duration'), ...docs.get('ev-B')!.filter((c) => c.attribute === 'duration')].map((c) => c.id).sort());
    });

    it('A=2 vs B=3 CONTRADICTS (high severity, value type, with an explanation); A and D AGREE', () => {
      const a = claimOf('ev-A', 'duration');
      const b3 = claimOf('ev-B', 'duration', (c) => c.value.normalized === 3);
      const contradicts = edges.filter((e) => e.type === 'CONTRADICTS' && [e.fromId, e.toId].sort().join() === [a.id, b3.id].sort().join());
      expect(contradicts).toHaveLength(1);
      expect(contradicts[0]).toMatchObject({ props: { type: 'value', severity: 'high', method: 'rule' }, runId: RUN });
      const explanation = (contradicts[0] as Extract<Edge, { type: 'CONTRADICTS' }>).props.explanation;
      expect(explanation).toContain('2 werkdagen');
      expect(explanation).toContain('3 werkdagen');
      const d = claimOf('ev-D', 'duration');
      expect(edges.some((e) => e.type === 'AGREES' && [e.fromId, e.toId].sort().join() === [a.id, d.id].sort().join())).toBe(true);
      expect(edges.some((e) => e.type === 'CONTRADICTS' && [e.fromId, e.toId].sort().join() === [a.id, d.id].sort().join())).toBe(false);
    });

    it('B’s injected 10-day claim is context (NOT_A_RULE) and only contradicts at low severity', () => {
      const inj = claimOf('ev-B', 'duration', (c) => c.value.normalized === 10);
      expect(edges.find((e) => e.type === 'MEMBER_OF' && e.fromId === inj.id)).toMatchObject({ props: { role: 'context', reason: 'NOT_A_RULE' } });
      const mine = edges.filter((e) => e.type === 'CONTRADICTS' && (e.fromId === inj.id || e.toId === inj.id));
      expect(mine.length).toBe(3);
      for (const e of mine) expect(e).toMatchObject({ props: { severity: 'low' } });
    });

    it('C is SCOPE_MISMATCH on every claim: rejected members of their own REJECTED facts, never merged with A/B/D', () => {
      expect(res.align.scopeMismatchClaimIds.sort()).toEqual(docs.get('ev-C')!.map((c) => c.id).sort());
      for (const c of docs.get('ev-C')!) {
        expect(edges.find((e) => e.type === 'MEMBER_OF' && e.fromId === c.id)).toMatchObject({ props: { role: 'rejected', reason: 'SCOPE_MISMATCH' } });
        const f = factOf(c.id);
        expect(f).toMatchObject({ status: 'REJECTED', scope: { country: 'NL' }, reasons: [{ code: 'SCOPE_MISMATCH' }] });
        expect(edges.filter((e) => e.type === 'MEMBER_OF' && e.toId === f.id)).toHaveLength(1);
      }
      const c3 = claimOf('ev-C', 'duration');
      const disjoint = edges.filter((e) => e.type === 'SCOPE_DISJOINT' && (e.fromId === c3.id || e.toId === c3.id));
      expect(disjoint).toHaveLength(4); // vs A, D, B3, B10
      for (const e of disjoint) expect(e).toMatchObject({ props: { differingScopeKeys: ['country'] } });
      // C says 3 days like B, but it never agrees with B: scope separates them
      expect(edges.some((e) => e.type === 'AGREES' && [e.fromId, e.toId].includes(c3.id))).toBe(false);
    });

    it('builds the expected graph: 6 live facts + 4 rejected, relation counts, nothing for C inside a live fact', () => {
      expect(facts.filter((f) => f.status === 'UNKNOWN').map((f) => f.attribute).sort()).toEqual(['deadline', 'duration', 'eligibility', 'pay_continuation', 'proof_required', 'timing_window']);
      expect(facts.filter((f) => f.status === 'REJECTED')).toHaveLength(4);
      expect(res.align.relations).toEqual({ AGREES: 6, CONTRADICTS: 5, REFINES: 0, SUPERSEDES: 0, SCOPE_DISJOINT: 9 });
      expect(facts.find((f) => f.attribute === 'deadline' && f.status === 'UNKNOWN')).not.toHaveProperty('slotId'); // no slot for it
      const proof = factOf(claimOf('ev-A', 'proof_required').id);
      expect(edges.filter((e) => e.type === 'MEMBER_OF' && e.toId === proof.id)).toHaveLength(3); // A, D and B state the same proof: one fact, all agreeing
    });

    it('no model call was needed: code decided every pair of this demo', async () => {
      const stats = (await brainRepo.listStageLogs(db, RUN)).find((l) => l.stage === '30-align')!.stats;
      expect(stats).toMatchObject({ claims: 17, inScope: 13, outOfScope: 4, offTopic: 0, llmCalls: 0, facts: 10, inScopeFacts: 6, scopeMismatchClaims: 4 });
    });
  });

  describe('40 gaps', () => {
    it('finds legal_basis and effective_from as MISSING_SLOT, and no gap at all for eligibility (or any other covered slot)', async () => {
      const g = await brainRepo.listGaps(db, RUN);
      const missing = g.filter((x) => x.type === 'MISSING_SLOT').map((x) => x.slotId).sort();
      expect(missing).toEqual(['effective_from', 'legal_basis']);
      for (const x of g.filter((y) => y.type === 'MISSING_SLOT')) expect(x).toMatchObject({ status: 'open', description: expect.stringMatching(/optional/) });
      expect(g.filter((x) => x.slotId === 'eligibility')).toEqual([]);
      const elig = factOf(claimOf('ev-A', 'eligibility').id);
      expect(g.filter((x) => x.factId === elig.id)).toEqual([]);
    });

    it('flags the duration fact as UNRESOLVED_CONFLICT and MISSING_TEMPORAL, linked to fact and slot; nothing is weak or unscoped', async () => {
      const g = await brainRepo.listGaps(db, RUN);
      const dur = factOf(claimOf('ev-A', 'duration').id);
      expect(g.filter((x) => x.factId === dur.id).map((x) => [x.type, x.slotId]).sort()).toEqual([['MISSING_TEMPORAL', 'duration'], ['UNRESOLVED_CONFLICT', 'duration']]);
      expect(g.map((x) => x.type).sort()).toEqual(['MISSING_SLOT', 'MISSING_SLOT', 'MISSING_TEMPORAL', 'UNRESOLVED_CONFLICT']);
      expect(res.gaps.gapsByType).toEqual({ MISSING_SLOT: 2, UNRESOLVED_CONFLICT: 1, MISSING_TEMPORAL: 1 });
    });

    it('logs both stages', async () => {
      const logs = await brainRepo.listStageLogs(db, RUN);
      expect(logs.map((l) => [l.stage, l.status])).toEqual([['00-intake', 'completed'], ['10-snapshot', 'completed'], ['20-extract', 'completed'], ['30-align', 'completed'], ['40-gaps', 'completed']]);
      expect(logs.find((l) => l.stage === '40-gaps')!.stats).toMatchObject({ gaps: 4, MISSING_SLOT: 2 });
    });
  });

  it('rerunning 30 and 40 recomputes identically (same ids, no duplicates)', async () => {
    const before = { facts: facts.map((f) => f.id).sort(), edges: edges.map((e) => e.id).sort(), gaps: (await brainRepo.listGaps(db, RUN)).map((g) => g.id).sort() };
    const a = await align(ctx, { runId: RUN, slotTemplate: res.intake.slotTemplate });
    const g = await gaps(ctx, { runId: RUN, slotTemplate: res.intake.slotTemplate });
    expect(a.factIds.sort()).toEqual(before.facts);
    expect((await edgeRepo.edgesByRun(db, RUN)).map((e) => e.id).sort()).toEqual(before.edges);
    expect(g.gapIds.sort()).toEqual(before.gaps);
    expect(await count(db, 'brain.fact')).toBe(before.facts.length);
  });

  it('a caller who can only read C gets every slot as a gap: out-of-scope claims never fill a slot', async () => {
    const fake = FakeProvider.fromDir(DEFAULT_FIXTURE_DIR);
    const c2 = createContext({ db, llm: fake, embedder: new FakeEmbedder(), now: () => NOW });
    const r = await runThroughGaps(c2, { question: DEMO_QUESTION, principalId: 'user:daan.visser', scopeHint: SCOPE_HINT, documents: ALL_DOCS, runId: runId('run-c-only') });
    expect(r.align.inScopeFactIds).toEqual([]);
    expect(r.align.scopeMismatchClaimIds).toHaveLength(4);
    expect(r.gaps.gapsByType).toEqual({ MISSING_SLOT: 7 });
  });
});

describe('the LLM tier through the real stage', () => {
  /** Embedder that puts chosen texts at a chosen cosine from each other (everything else is orthogonal). */
  const angled = (angles: Record<string, number>): Embedder => ({
    modelId: 'angled', dimensions: 768,
    embed: async (texts) => texts.map((t) => { const v = new Array<number>(768).fill(0); const a = angles[t] ?? 1.5; v[0] = Math.cos(a); v[1] = Math.sin(a); return v; }),
  });

  it('asks the model only for free-text pairs, stores its explanation and direction on the edge', async () => {
    const provider = new FakeProvider();
    const base = createContext({ db, llm: provider, embedder: angled({ 'opnemen binnen 4 weken na het huwelijk': 0, 'opnemen binnen de maand na het huwelijk': Math.acos(0.76) }), now: () => NOW });
    provider.register('intake', intakeTask(DEMO_QUESTION, base.templates.map((t) => ({ subject: t.subject, label: t.label }))).messages, { subject: 'leave.small_leave.own_marriage', matchesKnownSubject: true, scope: { country: null }, questionType: 'rule', proposedSlots: [] });

    const docs = [
      { uri: 'https://x.example/memo-x', title: 'Memo X', text: '# Memo X\n\n## Timing\n\nHet verlof moet opnemen binnen 4 weken na het huwelijk worden genomen.\n' },
      { uri: 'https://x.example/memo-y', title: 'Memo Y', text: '# Memo Y\n\n## Timing\n\nHet verlof moet opnemen binnen de maand na het huwelijk worden genomen.\n' },
    ];
    const claims = [
      { quote: 'opnemen binnen 4 weken na het huwelijk', valueRaw: 'binnen 4 weken na het huwelijk' },
      { quote: 'opnemen binnen de maand na het huwelijk', valueRaw: 'binnen de maand na het huwelijk' },
    ];
    docs.forEach((d, i) => {
      for (const p of splitPassages(d.text)) {
        const out = p.text.includes('Timing') ? { claims: [{ ...claims[i]!, subject: 'leave.small_leave.own_marriage', attribute: 'timing_window', qualifiers: i === 0 ? { country: 'BE', jointCommittee: 'PC 200', conditions: [] } : { country: 'BE', conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule', confidence: 0.9 }] } : { claims: [] }; // different scopes → different claimKeys → tiers 2/3
        provider.register('extract-evidence', extractEvidenceTask({ title: d.title, sourceSystem: 'other', declaredScope: {}, passage: p.text }).messages, out);
      }
    });

    const i = await intake(base, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, runId: runId('run-llm-tier') });
    const s = await snapshot(base, { runId: i.runId, principals: [NINA], documents: docs.map((d) => ({ uri: d.uri, text: d.text, metadata: { title: d.title } })) });
    await extract(base, { runId: i.runId, snapshotIds: s.documents.map((d) => d.snapshotId), slotTemplate: i.slotTemplate });
    const extracted = (await Promise.all(s.documents.map((d) => evidenceRepo.listClaimsBySnapshot(db, d.snapshotId)))).flat().sort((a, b) => a.id.localeCompare(b.id));
    expect(extracted).toHaveLength(2);

    // before the model is configured, the stage must fail loudly rather than guess
    await expect(align(base, { runId: i.runId, slotTemplate: i.slotTemplate })).rejects.toThrow(/No LLM fixture/);

    const [a, b] = extracted as [EvidenceClaim, EvidenceClaim];
    const side = (c: EvidenceClaim) => ({ scope: c.qualifiers, valueRaw: c.value.raw, quote: c.quote });
    provider.register('relation-classify', relationTask('leave.small_leave.own_marriage', 'timing_window', side(a), side(b)).messages, { relation: 'contradict', explanation: 'Het ene document zegt 4 weken, het andere een maand.', direction: null });

    const out = await align(base, { runId: i.runId, slotTemplate: i.slotTemplate });
    expect(out.inScopeFactIds).toHaveLength(1); // 0.76 → borderline → the model said "contradict" → same fact
    const edge = (await edgeRepo.edgesByRun(db, i.runId)).find((e) => e.type === 'CONTRADICTS') as Extract<Edge, { type: 'CONTRADICTS' }>;
    expect(edge.props).toEqual({ type: 'textual', severity: 'high', explanation: 'Het ene document zegt 4 weken, het andere een maand.', method: 'llm' });
    const stats = (await brainRepo.listStageLogs(db, i.runId)).find((l) => l.stage === '30-align')!.stats;
    expect(stats).toMatchObject({ llmCalls: 1, mergedByLlm: 1 });
    expect(provider.calls.filter((c) => c.promptId === 'relation-classify')).toHaveLength(2); // the failed attempt + the real one
  });
});
