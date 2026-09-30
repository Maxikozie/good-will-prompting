import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OrgEventSchema, runId, type Fact, type RunId } from '../src/domain';
import { DEFAULT_FIXTURE_DIR, FakeEmbedder, FakeProvider, type Embedder, type LLMProvider } from '../src/llm';
import { DEMO_QUESTION } from '../src/llm/record';
import { adjudicate, createContext, runThroughAdjudicate, runThroughEnrich, type PipelineCtx } from '../src/pipeline';
import { loadRules, rulesVersion } from '../src/rules';
import { SCORING_FILE } from '../src/scoring';
import { brainRepo, count, edgeRepo, pgliteDb, type Db } from '../src/store';
import { seedDemo } from '../src/store/seed';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const NINA = 'user:nina.maes';
const SCOPE_HINT = { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' };
const ALL_DOCS = ['ev-A', 'ev-B', 'ev-C', 'ev-D'].map((id) => ({ id }));

const boom = (what: string) => () => {
  throw new Error(`${what} must never be called during adjudication`);
};
const noLlm: LLMProvider = { modelId: 'no-llm', completeJSON: boom('the LLM') as never };
const noEmbedder: Embedder = { modelId: 'no-embedder', dimensions: 768, embed: boom('the embedder') as never };

let db: Db;
let ctx: PipelineCtx;
beforeAll(async () => {
  db = await pgliteDb();
  await seedDemo(db);
  ctx = createContext({ db, llm: FakeProvider.fromDir(DEFAULT_FIXTURE_DIR), embedder: new FakeEmbedder(), now: () => NOW });
});
afterAll(async () => db.close());

describe('the demo through stage 60', () => {
  let RUN: RunId;
  let res: Awaited<ReturnType<typeof runThroughAdjudicate>>;
  let facts: Fact[];
  const factOf = (attribute: string, referenceOnly = false) => facts.find((f) => f.attribute === attribute && f.referenceOnly === referenceOnly && f.status !== 'REJECTED')!;

  beforeAll(async () => {
    res = await runThroughAdjudicate(ctx, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, documents: ALL_DOCS });
    RUN = res.intake.runId;
    facts = await brainRepo.listFacts(db, RUN);
  });

  it('gives the duration fact the winner A=2 with status LIKELY (capped by rule 5), needsVerification, confidence in the "use with care" band', async () => {
    const f = factOf('duration');
    expect(f).toMatchObject({ status: 'LIKELY', needsVerification: true, winningValue: { normalized: 2, unit: 'days' }, impact: 'high' });
    expect(f.confidence).toBeGreaterThanOrEqual(70);
    expect(f.confidence).toBeLessThan(80);
    const scores = await brainRepo.listClaimScores(db, RUN);
    const winner = scores.find((s) => s.claimId === f.winnerClaimId)!;
    expect(winner).toMatchObject({ role: 'winner', sourceKind: 'evidence', sourceId: 'ev-A', factId: f.id });
    expect(f.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['OWNER_VERIFIED', 'CORROBORATED_INDEPENDENT', 'NEWER_BUT_UNVERIFIED', 'SUPERSEDED_TEMPORAL']));
  });

  it('records which ladder rules fired for the duration fact: 1, 2, 4 and 5 (not 3, 6, 7), decided by the last one that settled a conflict', async () => {
    const d = (await brainRepo.getFactDecision(db, RUN, factOf('duration').id))!;
    expect(d.fired.map((x) => [x.id, x.applies])).toEqual([['1_scope_split', true], ['2_duplicate_older', true], ['3_authority', false], ['4_temporal_supersession', true], ['5_newer_but_unverified', true], ['6_consensus', false], ['7_escalate', false]]);
    expect(d).toMatchObject({ decidedBy: '5_newer_but_unverified', cap: 'LIKELY', rulesVersion: rulesVersion(), independentCorroborations: 1, scopeFit: 1 });
    expect(d.correctionFor).toEqual([]);
    expect(d.escalateTo).toEqual([]);
  });

  it('persists the conflicts: B=3 vs A is OPEN at medium severity; W4 is resolved by temporal supersession (W1 is newer and verified)', async () => {
    const conflicts = await brainRepo.listConflicts(db, { runId: RUN });
    const dur = conflicts.filter((c) => c.factId === factOf('duration').id);
    expect(dur.map((c) => [c.resolution, c.status, c.severity, c.resolvedBy ?? null]).sort()).toEqual([
      ['5_newer_but_unverified', 'open', 'medium', null],
      ['4_temporal_supersession', 'resolved', 'high', 'rule'],
    ].sort());
    expect(conflicts.filter((c) => c.status === 'open' && c.severity === 'high')).toEqual([]);
    expect(res.adjudicate.openConflictIds).toHaveLength(1);
    const open = dur.find((c) => c.status === 'open')!;
    const scores = await brainRepo.listClaimScores(db, RUN);
    const b3 = scores.find((s) => s.sourceId === 'ev-B' && s.code === 'NEWER_BUT_UNVERIFIED')!;
    expect(open.claimIds).toContain(b3.claimId);
    expect(open.claimIds as string[]).toContain(factOf('duration').winnerClaimId as string);
  });

  it('gives every claim a score, breakdown, role and reason: winner, support, rejected (with codes), context, and excluded out-of-scope claims', async () => {
    const scores = await brainRepo.listClaimScores(db, RUN);
    const by = (sourceId: string, attribute?: string) => scores.filter((s) => s.sourceId === sourceId && (!attribute || s.factId === (facts.find((f) => f.attribute === attribute && f.status !== 'REJECTED' && !f.referenceOnly) ?? { id: '' }).id));
    const dur = (sourceId: string) => by(sourceId, 'duration');
    expect(dur('ev-A')[0]).toMatchObject({ role: 'winner' });
    expect(dur('ev-D')[0]).toMatchObject({ role: 'rejected', code: 'DUPLICATE_OLDER_VERSION' });
    expect(dur('ev-D')[0]!.score).toBeLessThanOrEqual(20);
    const b = dur('ev-B');
    expect(b.find((s) => s.code === 'NEWER_BUT_UNVERIFIED')).toMatchObject({ role: 'rejected', breakdown: { conflictPenalty: 15 } });
    expect(b.find((s) => s.code === 'NOT_A_RULE')).toMatchObject({ role: 'context' }); // the injected 10 days
    expect(b.find((s) => s.code === 'NOT_A_RULE')!.score).toBeLessThanOrEqual(25);
    expect(dur('wiki-W1')[0]).toMatchObject({ role: 'support', sourceKind: 'reference' });
    expect(dur('wiki-W2')[0]).toMatchObject({ role: 'context', code: 'DERIVED_COPY' });
    expect(dur('wiki-W4')[0]).toMatchObject({ role: 'rejected', code: 'SUPERSEDED_TEMPORAL' }); // 2019, no owner, unverified: replaced by the newer verified W1
    expect(dur('wiki-W4')[0]!.score).toBeLessThanOrEqual(20);
    for (const s of scores.filter((x) => x.sourceId === 'ev-C')) expect(s).toMatchObject({ role: 'rejected', code: 'SCOPE_MISMATCH', score: 0 });
    for (const s of scores) {
      expect(s.breakdown.total).toBe(s.score);
      expect(s.reasons.length).toBeGreaterThan(0);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
    expect(scores.length).toBe(17 + res.enrich.referenceFactIds.filter((id) => scores.some((x) => x.claimId === id)).length);
  });

  it('assigns the other statuses exactly per SPEC §6', () => {
    for (const a of ['eligibility', 'timing_window', 'pay_continuation', 'proof_required', 'deadline']) {
      expect(factOf(a), a).toMatchObject({ status: 'VERIFIED' });
    }
    expect(factOf('eligibility').needsVerification).toBe(false);
    expect(factOf('deadline').impact).toBe('low');
    // wiki-only answers are PROVISIONAL and need an owner
    for (const a of ['legal_basis', 'effective_from']) {
      expect(factOf(a, true), a).toMatchObject({ status: 'PROVISIONAL', needsVerification: true, referenceOnly: true });
      expect(factOf(a, true).reasons.map((r) => r.code)).toContain('REFERENCE_ONLY');
    }
    // the four out-of-scope facts stay rejected
    expect(facts.filter((f) => f.status === 'REJECTED')).toHaveLength(4);
    expect(facts.filter((f) => f.status === 'DISPUTED')).toEqual([]);
    expect(res.adjudicate.factsNeedingVerification.sort()).toEqual([factOf('duration').id, factOf('legal_basis', true).id, factOf('effective_from', true).id].sort());
  });

  it('the corroborated proof fact outscores the uncorroborated eligibility fact; corroboration lifts confidence', () => {
    expect(factOf('proof_required').confidence).toBeGreaterThan(factOf('eligibility').confidence);
    expect(factOf('eligibility').confidence).toBeLessThan(70); // VERIFIED does not need 70 (SPEC §6), it needs tier, decay and no open conflict
  });

  it('keeps the graph consistent: final MEMBER_OF roles match the stored scores; nothing from the wiki is a member of an evidence-backed fact as winner', async () => {
    const edges = await edgeRepo.edgesByRun(db, RUN);
    const scores = new Map((await brainRepo.listClaimScores(db, RUN)).map((s) => [s.claimId as string, s]));
    const member = edges.filter((e) => e.type === 'MEMBER_OF');
    expect(member.length).toBe(scores.size);
    for (const e of member) {
      if (e.type !== 'MEMBER_OF') continue;
      const s = scores.get(e.fromId)!;
      expect(e.props.role).toBe(s.role);
      expect(e.props.reason).toBe(s.code);
      expect(e.toId).toBe(s.factId);
    }
    for (const e of member) if (e.type === 'MEMBER_OF' && e.fromKind === 'reference_fact' && e.props.role === 'winner') expect(facts.find((f) => f.id === e.toId)!.referenceOnly).toBe(true);
  });

  it('logs the stage with its rule counts and proves no model was involved', async () => {
    const stage = (await brainRepo.listStageLogs(db, RUN)).find((l) => l.stage === '60-adjudicate')!;
    expect(stage.status).toBe('completed');
    expect(stage.stats).toMatchObject({ llmCalls: 0, rulesVersion: rulesVersion(), openConflicts: 1, byStatus: { LIKELY: 1, VERIFIED: 5, PROVISIONAL: 2, REJECTED: 4 } });
    expect((stage.stats as { rulesFired: Record<string, number> }).rulesFired).toMatchObject({ '1_scope_split': 4, '2_duplicate_older': 4, '4_temporal_supersession': 1, '5_newer_but_unverified': 1 });
  });

  it('never calls a model or an embedder: the stage runs to the same result with both replaced by something that throws', async () => {
    const before = { facts: (await brainRepo.listFacts(db, RUN)).map((f) => [f.id, f.status, f.confidence]), scores: (await brainRepo.listClaimScores(db, RUN)).map((s) => [s.claimId, s.score, s.role]) };
    const out = await adjudicate({ ...ctx, llm: noLlm, embedder: noEmbedder }, { runId: RUN, slotTemplate: res.intake.slotTemplate });
    expect(out.statuses[factOf('duration').id]).toBe('LIKELY');
    expect({ facts: (await brainRepo.listFacts(db, RUN)).map((f) => [f.id, f.status, f.confidence]), scores: (await brainRepo.listClaimScores(db, RUN)).map((s) => [s.claimId, s.score, s.role]) }).toEqual(before);
  });

  it('is idempotent: no duplicate conflicts, scores, decisions or edges after a rerun', async () => {
    const counts = async () => ({ conflicts: await count(db, 'brain.conflict'), scores: await count(db, 'brain.claim_score'), decisions: await count(db, 'brain.fact_decision'), edges: await count(db, 'brain.edge') });
    const a = await counts();
    await adjudicate(ctx, { runId: RUN, slotTemplate: res.intake.slotTemplate });
    expect(await counts()).toEqual(a);
  });

  it('an OrgEvent after the verification invalidates the winner: score ≤ 30, and the fact can no longer be VERIFIED', async () => {
    const d = await pgliteDb();
    try {
      await seedDemo(d);
      const c = createContext({ db: d, llm: FakeProvider.fromDir(DEFAULT_FIXTURE_DIR), embedder: new FakeEmbedder(), now: () => NOW });
      const r = await runThroughEnrich(c, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, documents: ALL_DOCS, runId: runId('run-event') });
      await brainRepo.saveOrgEvent(d, OrgEventSchema.parse({ id: 'oe-index', namespace: 'brain', createdAt: NOW.toISOString(), type: 'indexation', scope: { country: 'BE' }, domain: 'leave', effectiveAt: '2026-09-20T00:00:00.000Z' }));
      await brainRepo.saveOrgEvent(d, OrgEventSchema.parse({ id: 'oe-future', namespace: 'brain', createdAt: NOW.toISOString(), type: 'law_change', scope: { country: 'BE' }, domain: 'leave', effectiveAt: '2027-01-01T00:00:00.000Z' }));
      const out = await adjudicate(c, { runId: r.intake.runId, slotTemplate: r.intake.slotTemplate });
      const all = await brainRepo.listFacts(d, r.intake.runId);
      const elig = all.find((f) => f.attribute === 'eligibility' && f.status !== 'REJECTED')!;
      expect(out.statuses[elig.id]).not.toBe('VERIFIED');
      expect(elig.reasons.length).toBeGreaterThan(0);
      const scores = await brainRepo.listClaimScores(d, r.intake.runId);
      const a = scores.find((s) => s.claimId === elig.winnerClaimId) ?? scores.find((s) => s.factId === elig.id && s.role === 'winner')!;
      expect(a.score).toBeLessThanOrEqual(30);
      expect(a.breakdown.gates).toContain('invalidated≤30');
      expect(a.reasons.map((x) => x.code)).toContain('INVALIDATED_BY_EVENT');
    } finally {
      await d.close();
    }
  });
});

describe('determinism', () => {
  it('two runs on two fresh databases give identical statuses, confidences and scores', async () => {
    const run = async () => {
      const d = await pgliteDb();
      try {
        await seedDemo(d);
        const c = createContext({ db: d, llm: FakeProvider.fromDir(DEFAULT_FIXTURE_DIR), embedder: new FakeEmbedder(), now: () => NOW });
        const r = await runThroughAdjudicate(c, { question: DEMO_QUESTION, principalId: NINA, scopeHint: SCOPE_HINT, documents: ALL_DOCS, runId: runId('run-det') });
        return {
          facts: (await brainRepo.listFacts(d, r.intake.runId)).map((f) => [f.id, f.status, f.confidence, f.needsVerification, f.winnerClaimId ?? null]).sort(),
          scores: (await brainRepo.listClaimScores(d, r.intake.runId)).map((s) => [s.claimId, s.role, s.code ?? null, s.score, JSON.stringify(s.breakdown)]).sort(),
          conflicts: (await brainRepo.listConflicts(d, { runId: r.intake.runId })).map((x) => [x.id, x.status, x.severity, x.resolution]).sort(),
        };
      } finally {
        await d.close();
      }
    };
    expect(await run()).toEqual(await run());
  });
});

describe('no score or status ever comes from a model (static guarantee)', () => {
  const SRC = path.resolve(import.meta.dirname, '..', 'src');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
  it('src/rules, src/scoring and the adjudication stage import nothing from src/llm', () => {
    const offenders = [...files(path.join(SRC, 'rules')), ...files(path.join(SRC, 'scoring')), path.join(SRC, 'pipeline', '60-adjudicate.ts')].filter((f) => /from\s+['"][^'"]*\/llm(?:\/|['"])/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
  it('the stage does not reference ctx.llm or ctx.embedder', () => {
    expect(fs.readFileSync(path.join(SRC, 'pipeline', '60-adjudicate.ts'), 'utf8')).not.toMatch(/ctx\.(llm|embedder)/);
  });
});

describe('rules loading and rulesVersion', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brain-rules-'));
  const rulesText = fs.readFileSync(path.join(import.meta.dirname, '..', 'rules', 'rules.yaml'), 'utf8');

  it('rulesVersion is a hash of rules.yaml + scoring.yaml: any edit to either file changes it', () => {
    const dir = tmp();
    try {
      const r = path.join(dir, 'rules.yaml');
      const s = path.join(dir, 'scoring.yaml');
      fs.writeFileSync(r, rulesText);
      fs.copyFileSync(SCORING_FILE, s);
      const v1 = loadRules(r, s).version;
      expect(v1).toBe(rulesVersion()); // identical copies hash the same
      fs.writeFileSync(r, rulesText.replace('minScoreGap: 20', 'minScoreGap: 25'));
      const v2 = loadRules(r, s).version;
      expect(v2).not.toBe(v1);
      fs.appendFileSync(s, '\n# tweak\n');
      expect(loadRules(r, s).version).not.toBe(v2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a ladder with a missing, reordered or unknown rule, and invalid parameters, at load time', () => {
    const dir = tmp();
    try {
      const r = path.join(dir, 'rules.yaml');
      const write = (t: string) => fs.writeFileSync(r, t);
      write(rulesText.replace('  - id: 7_escalate', '  - id: 7_panic'));
      expect(() => loadRules(r, SCORING_FILE)).toThrow(/ladder must be exactly/);
      write(rulesText.replace('minIndependentGroups: 2', 'minIndependentGroups: 1'));
      expect(() => loadRules(r, SCORING_FILE)).toThrow();
      write(rulesText.replace('verifiedMinTier: T3', 'verifiedMinTier: T9'));
      expect(() => loadRules(r, SCORING_FILE)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the run stores the rulesVersion it was made with', async () => {
    const run = (await brainRepo.listFacts(db, (await db.query<{ id: string }>('SELECT id FROM brain.case_run LIMIT 1')).rows[0]!.id)).length;
    expect(run).toBeGreaterThan(0);
    const r = await db.query<{ rules_version: string }>('SELECT rules_version FROM brain.case_run');
    for (const row of r.rows) expect(row.rules_version).toBe(rulesVersion());
  });
});
