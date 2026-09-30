import { describe, expect, it } from 'vitest';
import { claimKey, evidenceClaimId, evidenceDocId, evidencePassageId, evidenceSnapshotId, normalizeValue, type EvidenceClaim, type Scope } from '../src/domain';
import { alignClaims, type AlignInput, type Relation } from '../src/evidence';
import type { RelationOutput } from '../src/llm';

const SUBJECT = 'leave.small_leave.own_marriage';
const QUERY: Scope = { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' };
const NOW = '2026-09-30T00:00:00.000Z';

interface C {
  id: string;
  attribute?: string;
  raw: string;
  quote?: string;
  scope?: Record<string, string | null>;
  modality?: EvidenceClaim['modality'];
  polarity?: EvidenceClaim['polarity'];
  conditions?: string[];
  effectiveFrom?: string;
  subject?: string;
}
function claim(c: C): EvidenceClaim {
  const attribute = c.attribute ?? 'duration';
  const subject = c.subject ?? SUBJECT;
  const qualifiers = { country: 'BE', jointCommittee: 'PC 200', ...c.scope, conditions: c.conditions ?? [] };
  return {
    id: evidenceClaimId(c.id), namespace: 'evidence', origin: 'evidence', sourceId: evidenceDocId(`doc-${c.id}`), snapshotId: evidenceSnapshotId('s'), passageId: evidencePassageId('p'),
    span: { start: 0, end: 1 }, quote: c.quote ?? c.raw, subject, attribute, value: normalizeValue(c.raw), qualifiers, temporal: c.effectiveFrom ? { effectiveFrom: c.effectiveFrom } : {},
    polarity: c.polarity ?? 'affirms', modality: c.modality ?? 'rule', extractionConfidence: 0.9, createdAt: NOW,
    claimKey: claimKey({ subject, attribute, qualifiers }),
  } as EvidenceClaim;
}

/** Embeddings by quote: unit vectors at a chosen angle, so the cosine between two quotes is exactly what a test needs. */
function embedder(angles: Record<string, number>) {
  return async (texts: string[]) => texts.map((t) => [Math.cos(angles[t] ?? 0), Math.sin(angles[t] ?? 0)]);
}
const acos = (sim: number) => Math.acos(sim);

function harness(claims: EvidenceClaim[], opts: { angles?: Record<string, number>; llm?: (a: EvidenceClaim, b: EvidenceClaim) => RelationOutput } = {}) {
  const asked: [string, string][] = [];
  const input: AlignInput = {
    claims, subject: SUBJECT, query: QUERY, embed: embedder(opts.angles ?? {}),
    classify: async (a, b) => {
      asked.push([a.id, b.id]);
      if (!opts.llm) throw new Error('the model must not be called here');
      return opts.llm(a, b);
    },
  };
  return { run: () => alignClaims(input), asked };
}
const rel = (r: Relation[], type: string) => r.filter((x) => x.type === type);
const ids = (f: { members: EvidenceClaim[] }) => f.members.map((m) => m.id);

describe('tier 1 and 2: exact claimKey, then same subject + attribute + overlapping scope with comparable values', () => {
  it('groups identical keys, merges comparable values across scopes that overlap, and keeps attributes apart', async () => {
    const { run, asked } = harness([
      claim({ id: 'a-dur', raw: '2 werkdagen' }),
      claim({ id: 'd-dur', raw: '2 werkdagen' }), // same key as A
      claim({ id: 'b-dur', raw: '3 werkdagen', scope: { jointCommittee: null as never, employeeCategory: undefined as never } }), // BE only: other key, overlapping scope
      claim({ id: 'a-pay', attribute: 'pay_continuation', raw: 'volledig loon doorbetaald' }),
    ]);
    const r = await run();
    const live = r.facts.filter((f) => f.inScope);
    expect(live.map((f) => [f.attribute, ids(f)])).toEqual([['duration', ['a-dur', 'b-dur', 'd-dur']], ['pay_continuation', ['a-pay']]]);
    expect(r.stats).toMatchObject({ exactGroups: 3, mergedDeterministic: 1, mergedByEmbedding: 0, mergedByLlm: 0, llmCalls: 0 });
    expect(asked).toEqual([]);
  });

  it('does not merge facts whose scopes conflict (different PC) even when the values are comparable', async () => {
    const r = await harness([claim({ id: 'x', raw: '2 dagen' }), claim({ id: 'y', raw: '3 dagen', scope: { jointCommittee: 'PC 311' } })]).run();
    expect(r.facts.filter((f) => f.inScope).map(ids)).toEqual([['x']]);
    expect(r.facts.filter((f) => !f.inScope).map(ids)).toEqual([['y']]); // PC 311 does not apply to a PC 200 question
  });

  it('claims about another subject are counted as off-topic and ignored', async () => {
    const r = await harness([claim({ id: 'x', raw: '2 dagen' }), claim({ id: 'y', raw: '3 dagen', subject: 'leave.small_leave.moving' })]).run();
    expect(r.stats).toMatchObject({ claims: 2, offTopic: 1, inScope: 1 });
    expect(r.facts).toHaveLength(1);
  });
});

describe('the query-scope filter', () => {
  it('keeps claims outside the scope in the graph as a rejected SCOPE_MISMATCH fact, with SCOPE_DISJOINT edges to the claims they differ from', async () => {
    const r = await harness([claim({ id: 'a', raw: '2 werkdagen' }), claim({ id: 'c', raw: '3 dagen', scope: { country: 'NL', jointCommittee: null as never } })]).run();
    expect(r.roles.get('c')).toEqual({ role: 'rejected', reason: 'SCOPE_MISMATCH' });
    expect(r.roles.get('a')).toEqual({ role: 'support' });
    expect(r.facts.map((f) => [f.inScope, ids(f)])).toEqual([[true, ['a']], [false, ['c']]]);
    expect(rel(r.relations, 'SCOPE_DISJOINT')).toEqual([expect.objectContaining({ from: 'a', to: 'c', differingScopeKeys: ['country'], method: 'rule' })]);
    expect(rel(r.relations, 'CONTRADICTS')).toEqual([]); // a different country is not a conflict
    expect(r.stats).toMatchObject({ inScope: 1, outOfScope: 1 });
  });

  it('an undeclared country (null) still applies to the question', async () => {
    const r = await harness([claim({ id: 'u', raw: '2 dagen', scope: { country: null } })]).run();
    expect(r.roles.get('u')).toEqual({ role: 'support' });
  });

  it('a non-rule claim stays in its fact as context (NOT_A_RULE) and only produces low-severity conflicts', async () => {
    const r = await harness([claim({ id: 'a', raw: '2 werkdagen' }), claim({ id: 'inj', raw: '10 dagen', modality: 'unknown' })]).run();
    expect(r.roles.get('inj')).toEqual({ role: 'context', reason: 'NOT_A_RULE' });
    expect(rel(r.relations, 'CONTRADICTS')).toEqual([expect.objectContaining({ contradiction: { type: 'value', severity: 'low' } })]);
  });
});

describe('pairwise relations inside a fact (deterministic first)', () => {
  it('labels A=2 vs B=3 CONTRADICTS (high) and equal values AGREES, with explanations', async () => {
    const r = await harness([claim({ id: 'a', raw: '2 werkdagen' }), claim({ id: 'b', raw: '3 werkdagen', scope: { jointCommittee: null as never } }), claim({ id: 'd', raw: '2 werkdagen' })]).run();
    const contradicts = rel(r.relations, 'CONTRADICTS');
    expect(contradicts.map((x) => [x.from, x.to, x.contradiction])).toEqual([['a', 'b', { type: 'value', severity: 'high' }], ['b', 'd', { type: 'value', severity: 'high' }]]);
    expect(contradicts[0]!.explanation).toContain('2 werkdagen');
    expect(rel(r.relations, 'AGREES')).toEqual([expect.objectContaining({ from: 'a', to: 'd', similarity: 1, method: 'rule' })]);
  });

  it('writes SUPERSEDES (newer → older) when both claims carry different effective dates, REFINES for containment and extra conditions', async () => {
    const r = await harness([
      claim({ id: 'old', attribute: 'rate', raw: '100%', effectiveFrom: '2022-01-01' }),
      claim({ id: 'new', attribute: 'rate', raw: '120%', effectiveFrom: '2026-09-01' }),
      claim({ id: 'n', attribute: 'dur2', raw: '2 dagen' }),
      claim({ id: 'r', attribute: 'dur2', raw: '1-3 dagen' }),
      claim({ id: 'c1', attribute: 'cond', raw: '5 dagen', conditions: ['na 1 jaar'] }),
      claim({ id: 'c2', attribute: 'cond', raw: '5 dagen' }),
    ]).run();
    expect(rel(r.relations, 'SUPERSEDES')).toEqual([expect.objectContaining({ from: 'new', to: 'old', basis: 'temporal' })]);
    expect(rel(r.relations, 'CONTRADICTS')).toEqual([]);
    expect(rel(r.relations, 'REFINES').map((x) => [x.from, x.to, x.addedQualifiers])).toEqual([['c1', 'c2', ['condition:na 1 jaar']], ['n', 'r', ['narrower range']]]);
  });

  it('opposite polarity with the same value is a polarity CONTRADICTS', async () => {
    const r = await harness([claim({ id: 'p', attribute: 'proof_required', raw: 'ja' }), claim({ id: 'q', attribute: 'proof_required', raw: 'ja', polarity: 'negates' })]).run();
    expect(rel(r.relations, 'CONTRADICTS')).toEqual([expect.objectContaining({ contradiction: { type: 'polarity', severity: 'high' } })]);
  });

  it('every pair of a fact gets exactly one label', async () => {
    const r = await harness([claim({ id: 'a', raw: '2 dagen' }), claim({ id: 'b', raw: '3 dagen' }), claim({ id: 'c', raw: '4 dagen' }), claim({ id: 'd', raw: '2 dagen' })]).run();
    const pairs = r.relations.filter((x) => x.type !== 'SCOPE_DISJOINT').map((x) => [x.from, x.to].sort().join('-'));
    expect(pairs.sort()).toEqual(['a-b', 'a-c', 'a-d', 'b-c', 'b-d', 'c-d']);
  });
});

describe('tier 2 (embedding ≥ 0.82) and tier 3 (LLM for 0.70–0.82) on free text', () => {
  const t1 = { id: 't1', attribute: 'timing_window', raw: 'binnen 4 weken na het huwelijk', quote: 'QUOTE-1', scope: { jointCommittee: null as never } };
  const t2 = { id: 't2', attribute: 'timing_window', raw: 'binnen de maand na het huwelijk', quote: 'QUOTE-2' };
  const llm = (relation: RelationOutput['relation'], direction: RelationOutput['direction'] = null) => () => ({ relation, explanation: 'De termijnen verschillen.', direction });

  it('merges at cosine ≥ 0.82 without calling the model for the merge (the differing text still needs a label)', async () => {
    const angles = { 'QUOTE-1': 0, 'QUOTE-2': acos(0.9) };
    const h = harness([claim(t1), claim(t2)], { angles, llm: llm('contradict') });
    const r = await h.run();
    expect(r.facts.filter((f) => f.inScope).map(ids)).toEqual([['t1', 't2']]);
    expect(r.stats).toMatchObject({ mergedByEmbedding: 1, mergedByLlm: 0, llmCalls: 1 }); // the single call labels the pair
    expect(rel(r.relations, 'CONTRADICTS')).toEqual([expect.objectContaining({ method: 'llm', contradiction: { type: 'textual', severity: 'high' }, explanation: 'De termijnen verschillen.' })]);
  });

  it.each([
    ['agree', 'AGREES'],
    ['contradict', 'CONTRADICTS'],
    ['refine', 'REFINES'],
    ['supersede', 'SUPERSEDES'],
  ] as const)('0.76 is borderline: the model decides; "%s" merges the claims and is stored as %s with its explanation', async (relation, edge) => {
    const angles = { 'QUOTE-1': 0, 'QUOTE-2': acos(0.76) };
    const h = harness([claim(t1), claim(t2)], { angles, llm: llm(relation, 'b') });
    const r = await h.run();
    expect(r.facts.filter((f) => f.inScope).map(ids)).toEqual([['t1', 't2']]);
    expect(r.stats).toMatchObject({ mergedByLlm: 1, llmCalls: 1 }); // asked once, reused for the pair label
    expect(h.asked).toEqual([['t1', 't2']]);
    const edges = rel(r.relations, edge);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ method: 'llm', explanation: 'De termijnen verschillen.' });
    if (edge === 'REFINES' || edge === 'SUPERSEDES') expect(edges[0]).toMatchObject({ from: 't2', to: 't1' }); // direction "b"
  });

  it('"unrelated" and "scope_disjoint" from the model keep the claims in separate facts', async () => {
    for (const relation of ['unrelated', 'scope_disjoint'] as const) {
      const r = await harness([claim(t1), claim(t2)], { angles: { 'QUOTE-1': 0, 'QUOTE-2': acos(0.75) }, llm: llm(relation) }).run();
      expect(r.facts.filter((f) => f.inScope).map(ids).sort()).toEqual([['t1'], ['t2']]);
      expect(r.relations.filter((x) => x.type !== 'SCOPE_DISJOINT')).toEqual([]);
    }
  });

  it('below 0.70 they are different facts and the model is never asked', async () => {
    const h = harness([claim(t1), claim(t2)], { angles: { 'QUOTE-1': 0, 'QUOTE-2': acos(0.6) } });
    const r = await h.run();
    expect(r.facts.filter((f) => f.inScope).map(ids).sort()).toEqual([['t1'], ['t2']]);
    expect(h.asked).toEqual([]);
  });

  it('a differing-text pair inside one exact-key fact is labelled by the model exactly once, in canonical order', async () => {
    const same = { attribute: 'eligibility', scope: {} };
    const h = harness([claim({ ...same, id: 'z', raw: 'alle bedienden', quote: 'Q-Z' }), claim({ ...same, id: 'y', raw: 'enkel bedienden met contract', quote: 'Q-Y' })], { llm: llm('refine', 'a') });
    const r = await h.run();
    expect(h.asked).toEqual([['y', 'z']]); // a.id < b.id
    expect(rel(r.relations, 'REFINES')).toEqual([expect.objectContaining({ from: 'y', to: 'z' })]);
    expect(r.stats.llmCalls).toBe(1);
  });

  it('numbers never reach the model: code compares them', async () => {
    const h = harness([claim({ id: 'a', raw: '2 dagen' }), claim({ id: 'b', raw: '3 uur' }), claim({ id: 'c', raw: '3 dagen' })], { llm: llm('contradict') });
    await h.run();
    // only the unit-mismatch pairs (2 dagen/3 uur and 3 uur/3 dagen) are undecidable for code
    expect(h.asked.length).toBeGreaterThan(0);
    expect(h.asked.some(([x, y]) => [x, y].sort().join() === 'a,c')).toBe(false);
  });

  it('an LLM "scope_disjoint" inside a fact becomes a SCOPE_DISJOINT edge with differing keys (fallback keys if none)', async () => {
    const same = { attribute: 'eligibility', scope: {} };
    const r = await harness([claim({ ...same, id: 'a', raw: 'alle bedienden' }), claim({ ...same, id: 'b', raw: 'enkel arbeiders', scope: {} })], { llm: llm('scope_disjoint') }).run();
    expect(rel(r.relations, 'SCOPE_DISJOINT')).toEqual([expect.objectContaining({ method: 'llm', differingScopeKeys: ['country'] })]);
  });
});

describe('determinism', () => {
  it('the same claims in any order give the same facts and relations', async () => {
    const claims = [claim({ id: 'a', raw: '2 werkdagen' }), claim({ id: 'b', raw: '3 werkdagen', scope: { jointCommittee: null as never } }), claim({ id: 'c', raw: '3 dagen', scope: { country: 'NL' } }), claim({ id: 'd', raw: '2 werkdagen' })];
    const one = await harness(claims).run();
    const two = await harness([...claims].reverse()).run();
    expect(two.facts.map((f) => [f.key, f.inScope, ids(f)])).toEqual(one.facts.map((f) => [f.key, f.inScope, ids(f)]));
    const norm = (r: Relation[]) => r.map((x) => `${x.type}:${x.from}>${x.to}`).sort();
    expect(norm(two.relations)).toEqual(norm(one.relations));
  });
});
