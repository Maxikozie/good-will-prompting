import { describe, expect, it } from 'vitest';
import type { Scope, Tier } from '../src/domain';
import {
  applyGates, claimScore, confidenceBand, conflictPenalty, consensusWeight, eventInvalidates, factConfidence, integrityWeight, loadScoringConfig, scopeFit, usageWeight, verificationWeight,
  type ScoreInput,
} from '../src/scoring';

const cfg = loadScoringConfig();
const NOW = new Date('2026-09-30T00:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const ctx = { now: NOW, halfLifeDays: 365, cfg };

const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  origin: 'evidence', modality: 'rule', tier: 'T3' as Tier, lastVerifiedAt: ago(0), lastEditedAt: ago(0), authority: 0.85, owner: { active: true }, agreeingGroups: 0, driftRatio: null,
  usage: { resolved: 0, reopened: 0 }, invalidatedByEvent: false, scopeUndeclared: false, derived: false, conflict: null, ruleGates: [], ...over,
});

describe('verification decay: V = tierWeight × 0.5^(days / halfLife)', () => {
  it.each([
    ['T3', 0, 365, 0.85],
    ['T3', 365, 365, 0.425],
    ['T3', 730, 365, 0.2125],
    ['T3', 182.5, 365, 0.85 * Math.SQRT1_2],
    ['T4', 90, 180, 0.5 ** 0.5],
    ['T2', 365, 730, 0.6 * Math.SQRT1_2],
    ['T1', 0, 365, 0.3],
    ['T0', 0, 365, 0],
  ])('%s after %s days (half-life %s) → %s', (tier, days, half, expected) => {
    expect(verificationWeight({ verifiedTier: tier as Tier, lastVerifiedAt: ago(days) }, NOW, half, cfg)).toBeCloseTo(expected, 10);
  });
  it('is 0 without a tier or a date, and never negative for a future date', () => {
    expect(verificationWeight({}, NOW, 365, cfg)).toBe(0);
    expect(verificationWeight({ verifiedTier: 'T4' }, NOW, 365, cfg)).toBe(0);
    expect(verificationWeight({ verifiedTier: 'T3', lastVerifiedAt: new Date(NOW.getTime() + 86_400_000).toISOString() }, NOW, 365, cfg)).toBeCloseTo(0.85, 10);
  });
  it('the half-life of a subject changes the decay', () => {
    const slow = verificationWeight({ verifiedTier: 'T3', lastVerifiedAt: ago(365) }, NOW, 730, cfg);
    const fast = verificationWeight({ verifiedTier: 'T3', lastVerifiedAt: ago(365) }, NOW, 180, cfg);
    expect(slow).toBeGreaterThan(fast);
  });
});

describe('the other components', () => {
  it('consensus C = min(1, 0.35 × independent agreeing groups)', () => {
    expect([0, 1, 2, 3, 4].map((n) => consensusWeight(n, cfg))).toEqual([0, 0.35, 0.7, 1, 1]);
    expect(consensusWeight(-1, cfg)).toBe(0);
  });
  it('usage U is Beta-smoothed: (resolved+1)/(resolved+reopened+2), neutral without data', () => {
    expect(usageWeight({ resolved: 0, reopened: 0 }, cfg)).toBe(0.5);
    expect(usageWeight({ resolved: 3, reopened: 1 }, cfg)).toBeCloseTo(4 / 6, 10);
    expect(usageWeight({ resolved: 0, reopened: 4 }, cfg)).toBeCloseTo(1 / 6, 10);
    expect(usageWeight({ resolved: 98, reopened: 0 }, cfg)).toBeCloseTo(99 / 100, 10);
  });
  it('integrity I: never verified → 0.5; verified and unchanged → 1; edited afterwards → 1 − drift (0.5 when the drift is unknown)', () => {
    const I = (over: Partial<Parameters<typeof integrityWeight>[0]>) => integrityWeight({ lastVerifiedAt: ago(10), lastEditedAt: ago(10), driftRatio: null, ...over }, cfg);
    expect(I({ lastVerifiedAt: undefined })).toBe(0.5);
    expect(I({})).toBe(1);
    expect(I({ lastEditedAt: ago(10), lastVerifiedAt: ago(5) })).toBe(1); // edited before it was verified
    expect(I({ lastEditedAt: ago(1), lastVerifiedAt: ago(10), driftRatio: 0.2 })).toBeCloseTo(0.8, 10);
    expect(I({ lastEditedAt: ago(1), lastVerifiedAt: ago(10), driftRatio: null })).toBe(0.5);
    expect(I({ lastEditedAt: ago(1), lastVerifiedAt: ago(10), driftRatio: 1 })).toBe(0);
  });
  it('conflict penalty: open high −30, medium −15, low −5, capped at −40', () => {
    expect([null, 'low', 'medium', 'high'].map((s) => conflictPenalty(s as never, cfg))).toEqual([0, 5, 15, 30]);
    expect(conflictPenalty('high', { ...cfg, conflictPenalty: { ...cfg.conflictPenalty, high: 55 } })).toBe(40);
  });
});

describe('claimScore: the formula, the breakdown and the reasons', () => {
  it('equals 100 × (0.30 V + 0.20 A + 0.15 O + 0.15 C + 0.10 I + 0.10 U) − penalty, rounded to 2 decimals', () => {
    const i = input({ tier: 'T3', lastVerifiedAt: ago(125), lastEditedAt: ago(125), authority: 0.85, owner: { active: true }, agreeingGroups: 1 });
    const V = 0.85 * 0.5 ** (125 / 365);
    const expected = 100 * (0.3 * V + 0.2 * 0.85 + 0.15 * 1 + 0.15 * 0.35 + 0.1 * 1 + 0.1 * 0.5);
    const r = claimScore(i, ctx);
    expect(r.score).toBeCloseTo(expected, 1);
    expect(r.score).toBe(Math.round(expected * 100) / 100);
    expect(r.breakdown).toMatchObject({ A: 0.85, O: 1, C: 0.35, I: 1, U: 0.5, conflictPenalty: 0, gates: [], total: r.score });
    expect(r.breakdown.V).toBeCloseTo(V, 2);
  });
  it('subtracts the conflict penalty and never goes below 0', () => {
    const base = claimScore(input({ agreeingGroups: 1 }), ctx).score;
    expect(claimScore(input({ agreeingGroups: 1, conflict: 'medium' }), ctx).score).toBeCloseTo(base - 15, 2);
    expect(claimScore(input({ tier: undefined, lastVerifiedAt: undefined, authority: 0.2, owner: null, conflict: 'high' }), ctx).score).toBe(0);
  });
  it('ownership tiers: active 1.0, inactive 0.4, none 0.2', () => {
    const O = (owner: ScoreInput['owner']) => claimScore(input({ owner }), ctx).breakdown.O;
    expect([O({ active: true }), O({ active: false }), O(null)]).toEqual([1, 0.4, 0.2]);
  });
  it('gates only lower: applyGates takes the lowest cap', () => {
    expect(applyGates(90, [{ name: 'expired', cap: 10 }])).toEqual({ score: 10, applied: ['expired≤10'] });
    expect(applyGates(5, [{ name: 'expired', cap: 10 }]).score).toBe(5);
    expect(applyGates(90, [{ name: 'not_a_rule', cap: 25 }, { name: 'expired', cap: 10 }]).score).toBe(10);
    expect(applyGates(90, []).score).toBe(90);
  });
  it('explains itself: a reason code for every condition', () => {
    const codes = (over: Partial<ScoreInput>) => claimScore(input(over), ctx).reasons.map((r) => r.code);
    expect(codes({})).toContain('OWNER_VERIFIED');
    expect(codes({ tier: undefined, lastVerifiedAt: undefined })).toContain('UNVERIFIED');
    expect(codes({ lastVerifiedAt: ago(800), lastEditedAt: ago(800) })).toContain('VERIFICATION_DECAYED');
    expect(codes({ owner: null })).toContain('NO_OWNER');
    expect(codes({ owner: { active: false } })).toContain('OWNER_INACTIVE');
    expect(codes({ lastVerifiedAt: ago(10), lastEditedAt: ago(2) })).toContain('EDITED_AFTER_VERIFICATION');
    expect(codes({ authority: 1 })).toContain('AUTHORITATIVE_SOURCE');
    expect(codes({ agreeingGroups: 2 })).toContain('CORROBORATED_INDEPENDENT');
    expect(codes({ validUntil: ago(1) })).toContain('EXPIRED');
    expect(codes({ invalidatedByEvent: true })).toContain('INVALIDATED_BY_EVENT');
    expect(codes({ modality: 'example' })).toContain('NOT_A_RULE');
    expect(codes({ derived: true })).toContain('DERIVED_COPY');
    expect(codes({ scopeUndeclared: true })).toContain('SCOPE_UNDECLARED');
    expect(codes({ origin: 'reference' })).toContain('REFERENCE_ONLY');
    for (const r of claimScore(input({ owner: null }), ctx).reasons) expect(r.message.length).toBeGreaterThan(5);
  });
  it('is pure: the same input gives the same output, and the input is not mutated', () => {
    const i = input({ agreeingGroups: 2 });
    const copy = JSON.parse(JSON.stringify(i));
    expect(claimScore(i, ctx)).toEqual(claimScore(i, ctx));
    expect(i).toEqual(copy);
  });
});

describe('scopeFit: exact 1.0 · parent 0.8 · product unknown 0.6 · other scope 0', () => {
  const q: Scope = { country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' };
  it.each([
    [{ country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende' }, q, 1],
    [{ country: 'BE', jointCommittee: 'PC 200', employeeCategory: 'bediende', product: 'hr' }, q, 1],
    [{ country: 'BE', jointCommittee: 'pc200', employeeCategory: 'Bediende' }, q, 1], // same after normalization
    [{ country: 'BE' }, q, 0.8], // parent: country-level for a committee question
    [{ country: 'BE', jointCommittee: 'PC 200' }, q, 0.8],
    [{ country: null }, q, 0.8], // undeclared country is broader, not wrong
    [{ country: 'NL', jointCommittee: 'PC 200' }, q, 0], // other country
    [{ country: 'BE', jointCommittee: 'PC 311' }, q, 0], // other committee
    [{ country: 'BE', customerId: 'Nordwind' }, { country: 'BE', customerId: 'Nordwind Retail' }, 0], // other customer
    [{ country: 'BE' }, { country: 'BE', customerId: 'Nordwind' }, 0.8], // country-level claim for a customer question
    [{ country: 'BE' }, { country: 'BE', product: 'pay' }, 0.6], // product unknown
    [{ country: 'BE', product: 'hr' }, { country: 'BE', product: 'pay' }, 0], // other product
    [{ country: 'BE' }, { country: 'BE', jointCommittee: 'PC 200', product: 'pay' }, 0.6], // the lowest applicable factor
  ] as [Record<string, string | null>, Scope, number][])('%j vs %j → %s', (claim, query, expected) => expect(scopeFit(claim as never, query, cfg)).toBe(expected));
  it('null-safe', () => {
    expect(scopeFit(null, { country: null }, cfg)).toBe(1);
    expect(scopeFit(undefined, q, cfg)).toBe(0.8);
  });
});

describe('factConfidence = min(100, winnerScore + 10 × min(1, corroborations / 2)) × ScopeFit', () => {
  it.each([
    [72.34, 0, 1, 72.34],
    [72.34, 1, 1, 77.34],
    [72.34, 2, 1, 82.34],
    [72.34, 5, 1, 82.34], // the bonus is capped
    [95, 2, 1, 100], // min(100, …)
    [72.34, 1, 0.8, 61.87],
    [80, 2, 0, 0], // other scope
  ])('winner %s, %s corroborations, fit %s → %s', (score, n, fit, expected) => expect(factConfidence(score, n, fit, cfg)).toBeCloseTo(expected, 2));
  it('bands: ≥ 80 trusted · 60–79 use with care · < 60 ask the owner', () => {
    expect([100, 80, 79.99, 60, 59.99, 0].map((c) => confidenceBand(c, cfg))).toEqual(['trusted', 'trusted', 'careful', 'careful', 'ask_owner', 'ask_owner']);
  });
});

describe('OrgEvent invalidation (gate INVALIDATED_BY_EVENT ≤ 30 until re-verified)', () => {
  const event = { domain: 'leave', scope: { country: 'BE' }, effectiveAt: '2026-09-20T00:00:00.000Z' };
  const claim = (over: Record<string, unknown> = {}) => ({ subject: 'leave.small_leave.own_marriage', scope: { country: 'BE', jointCommittee: 'PC 200' }, lastVerifiedAt: '2026-05-28T00:00:00.000Z', ...over });
  it('invalidates a claim verified before the event, in scope, in the domain, once the event is in force', () => {
    expect(eventInvalidates(event, claim(), NOW)).toBe(true);
    expect(eventInvalidates(event, claim({ lastVerifiedAt: undefined }), NOW)).toBe(true);
  });
  it('not when it was re-verified after the event, the event is in the future, the scope differs, or the domain differs', () => {
    expect(eventInvalidates(event, claim({ lastVerifiedAt: '2026-09-25T00:00:00.000Z' }), NOW)).toBe(false);
    expect(eventInvalidates({ ...event, effectiveAt: '2027-01-01T00:00:00.000Z' }, claim(), NOW)).toBe(false);
    expect(eventInvalidates({ ...event, scope: { country: 'NL' } }, claim(), NOW)).toBe(false);
    expect(eventInvalidates({ ...event, domain: 'payroll' }, claim(), NOW)).toBe(false);
    expect(eventInvalidates({ ...event, domain: 'leave.small' }, claim({ subject: 'leave.small_leave.x' }), NOW)).toBe(false); // dotted prefix, not a substring
    expect(eventInvalidates({ ...event, domain: 'leave.small_leave.own_marriage' }, claim(), NOW)).toBe(true);
  });
});
