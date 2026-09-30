import { describe, expect, it } from 'vitest';
import { normalizeValue, type Scope, type Tier } from '../src/domain';
import {
  adjudicateFact, assignStatus, loadRules, noOutcome, positionsOf, rule1ScopeSplit, rule2DuplicateOlder, rule3Authority, rule4TemporalSupersession, rule5NewerButUnverified,
  rule6Consensus, rule7Escalate, type Cand, type FactInput, type LadderCtx, type RuleState,
} from '../src/rules';
import { loadScoringConfig } from '../src/scoring';

const rules = loadRules();
const scoring = loadScoringConfig();
const NOW = new Date('2026-09-30T12:00:00.000Z');
const ctx: LadderCtx = { rules, scoring, now: NOW };
const QUERY: Scope = { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' };
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let n = 0;
function cand(over: Partial<Cand> & { raw?: string } = {}): Cand {
  const id = over.id ?? `c${++n}`;
  const { raw, ...rest } = over;
  return {
    id, origin: 'evidence', sourceId: `doc-${id}`, group: `g-${id}`, value: normalizeValue(raw ?? '2 werkdagen'), polarity: 'affirms', conditions: [], modality: 'rule',
    scope: { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' }, scopeUndeclared: false, lastEditedAt: day(100), authority: 0.7, owner: { active: true },
    ownerId: `owner-${id}`, driftRatio: null, usage: { resolved: 0, reopened: 0 }, invalidatedByEvent: false, ...rest,
  };
}
const fact = (cands: Cand[], over: Partial<FactInput> = {}): FactInput => ({ factId: 'f1', impact: 'high', halfLifeDays: 365, query: QUERY, candidates: cands, context: [], scopeMismatched: 0, duplicates: [], agreeing: [], ...over });
const state = (live: Cand[], input?: Partial<FactInput>, base: Record<string, number> = {}): RuleState => ({ live, base: new Map(live.map((c) => [c.id, base[c.id] ?? 50])), positions: positionsOf(live, []), input: fact(live, input) });
const role = (r: ReturnType<typeof adjudicateFact>, id: string) => r.claims.find((c) => c.id === id)!;
const verified = (tier: Tier, daysAgo: number) => ({ tier, lastVerifiedAt: day(daysAgo) });

describe('the ladder file', () => {
  it('has the seven rules in SPEC order, with validated parameters, and a rulesVersion that is a hash of both files', () => {
    expect(rules.config.ladder.map((s) => s.id)).toEqual(['1_scope_split', '2_duplicate_older', '3_authority', '4_temporal_supersession', '5_newer_but_unverified', '6_consensus', '7_escalate']);
    expect(rules.params).toMatchObject({ strongTier: 'T4', strongAuthority: 1, conflictSeverity5: 'medium', statusCap5: 'LIKELY', minIndependentGroups: 2, minScoreGap: 20, statusCap6: 'LIKELY', conflictSeverity7: 'high' });
    expect(rules.version).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('rule 1 — scope split', () => {
  it('applies when claims about another scope were set aside; it makes no conflict and rejects nothing itself', () => {
    const res = rule1ScopeSplit(state([cand()], { scopeMismatched: 2 }));
    expect(res.applies).toBe(true);
    expect(res.outcome).toEqual(noOutcome());
    expect(res.reasons[0]).toMatchObject({ code: 'SCOPE_MISMATCH' });
    expect(rule1ScopeSplit(state([cand()])).applies).toBe(false);
  });
  it('is recorded as fired by adjudicateFact, and the set-aside claims do not make the fact disputed', () => {
    const r = adjudicateFact(fact([cand({ id: 'a', ...verified('T3', 30) })], { scopeMismatched: 1 }), ctx);
    expect(r.fired.find((f) => f.id === '1_scope_split')!.applies).toBe(true);
    expect(r.status).toBe('VERIFIED');
    expect(r.conflicts).toEqual([]);
  });
});

describe('rule 2 — duplicate of an older version', () => {
  it('rejects the older claim (DUPLICATE_OLDER_VERSION), keeps the newer, and never treats them as two sources', () => {
    const newer = cand({ id: 'a', group: 'ev-A', lastEditedAt: day(120), ...verified('T3', 120) });
    const older = cand({ id: 'd', group: 'ev-A', lastEditedAt: day(1000) });
    const res = rule2DuplicateOlder(state([newer, older], { duplicates: [['a', 'd']] }));
    expect(res.applies).toBe(true);
    expect(res.outcome.rejected).toEqual([{ id: 'd', code: 'DUPLICATE_OLDER_VERSION' }]);
    const r = adjudicateFact(fact([newer, older], { duplicates: [['d', 'a']] }), ctx);
    expect(role(r, 'd')).toMatchObject({ role: 'rejected', code: 'DUPLICATE_OLDER_VERSION' });
    expect(role(r, 'd').breakdown.gates).toContain('duplicate_older≤20');
    expect(role(r, 'd').score).toBeLessThanOrEqual(20);
    expect(r.winnerId).toBe('a');
    expect(r.independentCorroborations).toBe(0); // the copy adds no independent source
  });
  it('does nothing for equally old copies or for passages inside one document', () => {
    const a = cand({ id: 'a', lastEditedAt: day(10) });
    const b = cand({ id: 'b', lastEditedAt: day(10) });
    expect(rule2DuplicateOlder(state([a, b], { duplicates: [['a', 'b']] })).applies).toBe(false);
    const c = cand({ id: 'c', sourceId: 'same', lastEditedAt: day(10) });
    const d = cand({ id: 'd', sourceId: 'same', lastEditedAt: day(99) });
    expect(rule2DuplicateOlder(state([c, d], { duplicates: [['c', 'd']] })).applies).toBe(false);
  });
});

describe('rule 3 — authority', () => {
  const law = cand({ id: 'law', raw: '3 dagen', authority: 1, ...verified('T4', 10) });
  const policy = cand({ id: 'pol', raw: '2 dagen', ...verified('T3', 10) });
  it('the one side with T4 / authority 1.0 wins; the other is rejected and its owner gets a correction task', () => {
    const res = rule3Authority(state([law, policy]), ctx);
    expect(res.applies).toBe(true);
    expect(res.outcome.rejected).toEqual([{ id: 'pol', code: 'CONTRADICTED_BY_AUTHORITY' }]);
    expect(res.outcome.correctionFor).toEqual(['pol']);
    expect(res.outcome.conflicts[0]).toMatchObject({ status: 'resolved', resolvedBy: 'rule', resolution: '3_authority', severity: 'high' });
    const r = adjudicateFact(fact([law, policy]), ctx);
    expect(r.winnerId).toBe('law');
    expect(r.decidedBy).toBe('3_authority');
    expect(r.correctionFor).toEqual(['pol']);
    expect(r.status).toBe('VERIFIED');
  });
  it('does not apply when both or neither side is authoritative', () => {
    expect(rule3Authority(state([law, cand({ id: 'law2', raw: '2 dagen', authority: 1 })]), ctx).applies).toBe(false);
    expect(rule3Authority(state([policy, cand({ id: 'x', raw: '3 dagen' })]), ctx).applies).toBe(false);
    expect(rule3Authority(state([law]), ctx).applies).toBe(false); // nothing to contradict
  });
});

describe('rule 4 — temporal supersession', () => {
  it('a newer claim with a later effective date and ≥ tier SUPERSEDES the older one (rejected, capped at 20)', () => {
    const old = cand({ id: 'old', raw: '100%', effectiveFrom: '2022-01-01', lastEditedAt: day(1500), ...verified('T3', 1500) });
    const neu = cand({ id: 'new', raw: '120%', effectiveFrom: '2026-09-01', lastEditedAt: day(20), ...verified('T3', 20) });
    const res = rule4TemporalSupersession(state([old, neu]));
    expect(res.applies).toBe(true);
    expect(res.outcome.supersedes).toEqual([{ newer: 'new', older: 'old' }]);
    expect(res.outcome.rejected).toEqual([{ id: 'old', code: 'SUPERSEDED_TEMPORAL' }]);
    expect(res.outcome.conflicts[0]).toMatchObject({ type: 'temporal', status: 'resolved', resolution: '4_temporal_supersession' });
    const r = adjudicateFact(fact([old, neu]), ctx);
    expect(r.winnerId).toBe('new');
    expect(r.supersedes).toEqual([{ newer: 'new', older: 'old' }]);
    expect(role(r, 'old')).toMatchObject({ role: 'rejected', code: 'SUPERSEDED_TEMPORAL' });
    expect(role(r, 'old').score).toBeLessThanOrEqual(scoring.gates.superseded);
    expect(role(r, 'old').breakdown.gates).toContain('superseded≤20');
  });
  it('does not apply when the newer claim has a lower tier, or no key date at all', () => {
    const old = cand({ id: 'o', raw: '2 dagen', lastEditedAt: day(300), ...verified('T3', 300) });
    const lower = cand({ id: 'n', raw: '3 dagen', lastEditedAt: day(5), ...verified('T1', 5) });
    expect(rule4TemporalSupersession(state([old, lower])).applies).toBe(false);
    expect(rule4TemporalSupersession(state([old, cand({ id: 'u', raw: '3 dagen', lastEditedAt: day(5) })])).applies).toBe(false);
  });
});

describe('rule 5 — newest ≠ correct', () => {
  const A = () => cand({ id: 'a', raw: '2 werkdagen', lastEditedAt: day(125), ...verified('T3', 125) });
  const B = () => cand({ id: 'b', raw: '3 werkdagen', lastEditedAt: day(7) });
  it('the verified older claim wins provisionally; the newer is flagged; the conflict stays OPEN at medium severity; the fact is capped', () => {
    const res = rule5NewerButUnverified(state([A(), B()]), ctx);
    expect(res.applies).toBe(true);
    expect(res.outcome.rejected).toEqual([{ id: 'b', code: 'NEWER_BUT_UNVERIFIED' }]);
    expect(res.outcome.conflicts).toEqual([{ type: 'value', severity: 'medium', status: 'open', resolution: '5_newer_but_unverified', claimIds: ['b', 'a'] }]);
    expect(res.outcome.cap).toBe('LIKELY');
    const r = adjudicateFact(fact([A(), B()]), ctx);
    expect(r.winnerId).toBe('a');
    expect(r.status).toBe('LIKELY'); // VERIFIED is capped
    expect(r.needsVerification).toBe(true); // LIKELY + impact high
    expect(r.decidedBy).toBe('5_newer_but_unverified');
    expect(r.conflicts).toHaveLength(1);
    expect(r.reasons.map((x) => x.code)).toContain('NEWER_BUT_UNVERIFIED');
    expect(role(r, 'b')).toMatchObject({ role: 'rejected', code: 'NEWER_BUT_UNVERIFIED' });
    expect(role(r, 'b').breakdown.conflictPenalty).toBe(15); // the flagged claim carries the open medium conflict
    expect(role(r, 'a').breakdown.conflictPenalty).toBe(0); // the provisional winner does not
  });
  it('does not apply when tiers are equal or the newer claim is better verified', () => {
    expect(rule5NewerButUnverified(state([cand({ id: 'x', raw: '2 dagen', lastEditedAt: day(50) }), cand({ id: 'y', raw: '3 dagen', lastEditedAt: day(5) })]), ctx).applies).toBe(false);
    expect(rule5NewerButUnverified(state([A(), cand({ id: 'z', raw: '3 dagen', lastEditedAt: day(5), ...verified('T4', 5) })]), ctx).applies).toBe(false);
  });
});

describe('rule 6 — consensus', () => {
  const two = (over: Partial<Cand>) => cand({ raw: '2 dagen', ...over });
  it('≥ 2 independent groups that outscore the dissent by ≥ 20 win; the dissent is rejected; the fact is capped', () => {
    const a = two({ id: 'a', group: 'g1' });
    const w = two({ id: 'w', group: 'g2', origin: 'reference' });
    const odd = cand({ id: 'odd', raw: '1 dag', group: 'g3' });
    const res = rule6Consensus(state([a, w, odd], {}, { a: 70, w: 60, odd: 23 }), ctx);
    expect(res.applies).toBe(true);
    expect(res.outcome.rejected).toEqual([{ id: 'odd', code: 'CONTRADICTED_BY_CONSENSUS' }]);
    expect(res.outcome.cap).toBe('LIKELY');
    expect(res.outcome.conflicts[0]).toMatchObject({ status: 'resolved', resolution: '6_consensus', resolvedBy: 'rule' });
  });
  it('needs two independent GROUPS: a copy in the same group does not count', () => {
    const a = two({ id: 'a', group: 'g1' });
    const copy = two({ id: 'copy', group: 'g1', origin: 'reference' });
    const odd = cand({ id: 'odd', raw: '1 dag', group: 'g3' });
    expect(rule6Consensus(state([a, copy, odd], {}, { a: 70, copy: 70, odd: 10 }), ctx).applies).toBe(false);
  });
  it('needs a score gap ≥ 20 over every dissent', () => {
    const a = two({ id: 'a', group: 'g1' });
    const w = two({ id: 'w', group: 'g2' });
    const odd = cand({ id: 'odd', raw: '1 dag', group: 'g3' });
    expect(rule6Consensus(state([a, w, odd], {}, { a: 70, w: 60, odd: 55 }), ctx).applies).toBe(false);
    expect(rule6Consensus(state([a, w, odd], {}, { a: 70, w: 60, odd: 50 }), ctx).applies).toBe(true); // exactly 20
  });
});

describe('rule 7 — escalate', () => {
  it('two unresolved positions make the fact DISPUTED, open a high conflict and ask every owner', () => {
    const x = cand({ id: 'x', raw: '2 dagen', lastEditedAt: day(30) });
    const y = cand({ id: 'y', raw: '3 dagen', lastEditedAt: day(40) });
    const res = rule7Escalate(state([x, y]), ctx);
    expect(res.applies).toBe(true);
    expect(res.outcome.disputed).toBe(true);
    expect(res.outcome.escalateTo).toEqual(['x', 'y']);
    const r = adjudicateFact(fact([x, y]), ctx);
    expect(r).toMatchObject({ status: 'DISPUTED', needsVerification: true, decidedBy: '7_escalate', escalateTo: ['x', 'y'], confidence: 0 });
    expect(r.winnerId).toBeUndefined();
    expect(r.conflicts).toEqual([expect.objectContaining({ status: 'open', severity: 'high', resolution: '7_escalate' })]);
    expect(role(r, 'x').breakdown.conflictPenalty).toBe(30);
    expect(rule7Escalate(state([x]), ctx).applies).toBe(false);
  });
});

describe('old vs new: the full 2×2 matrix (SPEC §7)', () => {
  // "new" = edited more recently and claiming 3 days; "old" = 2 days. Verified = tier ≥ T1 with a verification date.
  const pair = (oldVerified: boolean, newVerified: boolean) => [
    cand({ id: 'old', raw: '2 dagen', lastEditedAt: day(200), ...(oldVerified ? verified('T3', 200) : {}) }),
    cand({ id: 'new', raw: '3 dagen', lastEditedAt: day(10), ...(newVerified ? verified('T3', 10) : {}) }),
  ];

  it('new verified × old verified → new wins (rule 4)', () => {
    const r = adjudicateFact(fact(pair(true, true)), ctx);
    expect(r).toMatchObject({ winnerId: 'new', decidedBy: '4_temporal_supersession' });
    expect(role(r, 'old')).toMatchObject({ role: 'rejected', code: 'SUPERSEDED_TEMPORAL' });
    expect(r.conflicts.every((c) => c.status === 'resolved')).toBe(true);
    expect(r.status).toBe('VERIFIED');
  });
  it('new verified × old unverified → new wins (rule 4)', () => {
    const r = adjudicateFact(fact(pair(false, true)), ctx);
    expect(r).toMatchObject({ winnerId: 'new', decidedBy: '4_temporal_supersession' });
    expect(role(r, 'old').code).toBe('SUPERSEDED_TEMPORAL');
  });
  it('new unverified × old verified → old wins provisionally + OPEN conflict (rule 5)', () => {
    const r = adjudicateFact(fact(pair(true, false)), ctx);
    expect(r).toMatchObject({ winnerId: 'old', decidedBy: '5_newer_but_unverified', status: 'LIKELY' });
    expect(r.conflicts).toEqual([expect.objectContaining({ status: 'open', severity: 'medium' })]);
    expect(role(r, 'new').code).toBe('NEWER_BUT_UNVERIFIED');
  });
  it('new unverified × old unverified → both weak: consensus (rule 6) or escalation (rule 7)', () => {
    const r = adjudicateFact(fact(pair(false, false)), ctx);
    expect(r.decidedBy).toBe('7_escalate');
    expect(r.status).toBe('DISPUTED');
    // with two independent agreeing sources behind the old claim and a clearly weaker new claim (no owner, an email), rule 6 decides
    const weakNew = cand({ id: 'new', raw: '3 dagen', lastEditedAt: day(10), authority: 0.3, owner: null, ownerId: undefined });
    const backed = [pair(false, false)[0]!, weakNew, cand({ id: 'wiki', raw: '2 dagen', origin: 'reference', authority: 0.7, lastEditedAt: day(60) })];
    const r6 = adjudicateFact(fact(backed), ctx);
    expect(r6.decidedBy).toBe('6_consensus');
    expect(r6.winnerId).toBe('old');
    expect(role(r6, 'new').code).toBe('CONTRADICTED_BY_CONSENSUS');
    expect(r6.status).not.toBe('VERIFIED');
  });
});

describe('hard gates (SPEC §8.1) — one per gate', () => {
  const score = (over: Partial<Cand>) => role(adjudicateFact(fact([cand({ id: 'x', authority: 1, owner: { active: true }, ...verified('T4', 1), lastEditedAt: day(1), ...over })]), ctx), 'x');
  const strong = score({});

  it('an unimpaired, fully verified, authoritative claim scores high', () => {
    expect(strong.score).toBeGreaterThan(75); // 100 × (0.30 + 0.20 + 0.15 + 0 + 0.10 + 0.05): no corroboration yet
    expect(strong.breakdown.gates).toEqual([]);
  });
  it('EXPIRED → ≤ 10', () => {
    const s = score({ validUntil: day(1) });
    expect(s.score).toBeLessThanOrEqual(10);
    expect(s.breakdown.gates).toContain('expired≤10');
    expect(s.reasons.map((r) => r.code)).toContain('EXPIRED');
  });
  it('INVALIDATED_BY_EVENT → ≤ 30', () => {
    const s = score({ invalidatedByEvent: true });
    expect(s.score).toBeLessThanOrEqual(30);
    expect(s.breakdown.gates).toContain('invalidated≤30');
    expect(s.reasons.map((r) => r.code)).toContain('INVALIDATED_BY_EVENT');
  });
  it('NOT_A_RULE → ≤ 25', () => {
    const s = score({ modality: 'opinion' });
    expect(s.score).toBeLessThanOrEqual(25);
    expect(s.breakdown.gates).toContain('not_a_rule≤25');
  });
  it('superseded → ≤ 20 (see rule 4) and older duplicate → ≤ 20 (see rule 2); gates only ever lower a score', () => {
    expect(scoring.gates).toMatchObject({ expired: 10, superseded: 20, invalidated: 30, not_a_rule: 25, duplicate_older: 20 });
    const both = score({ validUntil: day(1), invalidatedByEvent: true, modality: 'opinion' });
    expect(both.score).toBeLessThanOrEqual(10); // the lowest cap wins
  });
  it('a claim outside the query scope is excluded (scopeFit 0), not scored as evidence', () => {
    const r = adjudicateFact(fact([cand({ id: 'nl', scope: { country: 'NL' }, ...verified('T3', 10) })]), ctx);
    expect(r.scopeFit).toBe(0);
    expect(r.confidence).toBe(0);
  });
});

describe('status per SPEC §6, including needsVerification', () => {
  const s = (over: Partial<Parameters<typeof assignStatus>[0]>) => assignStatus({ hasWinner: true, disputed: false, winnerOrigin: 'evidence', winnerTier: 'T3', decay: 0.8, expired: false, confidence: 80, openHighConflict: false, impact: 'medium', ...over }, rules);

  it('VERIFIED: tier ≥ T3, decay ≥ 0.5, not expired, no open high conflict', () => {
    expect(s({})).toEqual({ status: 'VERIFIED', needsVerification: false });
    expect(s({ winnerTier: 'T4' }).status).toBe('VERIFIED');
    expect(s({ winnerTier: 'T2', confidence: 75 }).status).toBe('LIKELY');
    expect(s({ decay: 0.49, confidence: 75 }).status).toBe('LIKELY');
    expect(s({ decay: 0.5 }).status).toBe('VERIFIED'); // exactly at the boundary
    expect(s({ expired: true, confidence: 75 }).status).toBe('LIKELY');
    expect(s({ openHighConflict: true, confidence: 75 }).status).toBe('PROVISIONAL');
    expect(s({ decay: null }).status).toBe('LIKELY'); // never verified cannot be VERIFIED
  });
  it('LIKELY needs confidence ≥ 70; below that a winner is PROVISIONAL', () => {
    expect(s({ winnerTier: 'T0', confidence: 70 }).status).toBe('LIKELY');
    expect(s({ winnerTier: 'T0', confidence: 69.99 }).status).toBe('PROVISIONAL');
  });
  it('reference-only winners are PROVISIONAL at best, however strong', () => {
    expect(s({ winnerOrigin: 'reference', confidence: 100 })).toEqual({ status: 'PROVISIONAL', needsVerification: true });
  });
  it('DISPUTED without a winner; UNKNOWN when nothing is left', () => {
    expect(s({ hasWinner: false, disputed: true })).toEqual({ status: 'DISPUTED', needsVerification: true });
    expect(s({ hasWinner: false })).toEqual({ status: 'UNKNOWN', needsVerification: false });
  });
  it('needsVerification = DISPUTED ∨ PROVISIONAL ∨ (LIKELY ∧ impact high)', () => {
    expect(s({ winnerTier: 'T0', confidence: 80, impact: 'high' })).toEqual({ status: 'LIKELY', needsVerification: true });
    expect(s({ winnerTier: 'T0', confidence: 80, impact: 'medium' })).toEqual({ status: 'LIKELY', needsVerification: false });
    expect(s({ impact: 'high' })).toEqual({ status: 'VERIFIED', needsVerification: false });
  });
  it('a cap lowers VERIFIED to LIKELY and never raises anything', () => {
    expect(s({ cap: 'LIKELY' }).status).toBe('LIKELY');
    expect(s({ cap: 'LIKELY', winnerTier: 'T0', confidence: 50 }).status).toBe('PROVISIONAL');
    expect(s({ cap: 'LIKELY', hasWinner: false, disputed: true }).status).toBe('DISPUTED');
  });
});

describe('adjudicateFact basics', () => {
  it('a single verified claim: VERIFIED, no conflict, no ladder rule beyond 1–2 fires', () => {
    const r = adjudicateFact(fact([cand({ id: 'a', ...verified('T3', 30), lastEditedAt: day(30) })]), ctx);
    expect(r).toMatchObject({ status: 'VERIFIED', winnerId: 'a', decidedBy: null, conflicts: [], needsVerification: false });
    expect(r.fired.map((f) => f.id)).toEqual(['1_scope_split', '2_duplicate_older', '3_authority', '4_temporal_supersession', '5_newer_but_unverified', '6_consensus', '7_escalate']);
    expect(r.fired.every((f) => !f.applies)).toBe(true);
  });
  it('is deterministic: candidate order does not matter', () => {
    const cs = [cand({ id: 'a', raw: '2 dagen', ...verified('T3', 100), lastEditedAt: day(100) }), cand({ id: 'b', raw: '3 dagen', lastEditedAt: day(5) }), cand({ id: 'c', raw: '2 dagen', group: 'other', origin: 'reference' })];
    const one = adjudicateFact(fact(cs), ctx);
    const two = adjudicateFact(fact([...cs].reverse()), ctx);
    expect(two.winnerId).toBe(one.winnerId);
    expect(two.status).toBe(one.status);
    expect(two.confidence).toBe(one.confidence);
    expect(two.claims.map((c) => [c.id, c.role, c.score]).sort()).toEqual(one.claims.map((c) => [c.id, c.role, c.score]).sort());
  });
  it('an evidence candidate wins over a reference one inside the same position', () => {
    const ev = cand({ id: 'ev', raw: '2 dagen', group: 'g1' });
    const ref = cand({ id: 'wiki', raw: '2 dagen', group: 'g2', origin: 'reference', ...verified('T2', 30), lastEditedAt: day(30) });
    const r = adjudicateFact(fact([ev, ref]), ctx);
    expect(r.winnerId).toBe('ev');
    expect(r.independentCorroborations).toBe(1);
  });
  it('a fact whose only winner comes from the wiki is PROVISIONAL with the REFERENCE_ONLY reason', () => {
    const r = adjudicateFact(fact([cand({ id: 'wiki', origin: 'reference', group: 'w', authority: 0.7, ...verified('T2', 30), lastEditedAt: day(30) })], { impact: 'low' }), ctx);
    expect(r.status).toBe('PROVISIONAL');
    expect(r.reasons.map((x) => x.code)).toContain('REFERENCE_ONLY');
  });
});
