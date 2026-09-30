import type { Reason, ReasonCode, ScoreBreakdown, Severity, Tier } from '../domain';
import type { ScoringConfig } from './config';
import { DAY_MS, verificationWeight } from './preliminary';

// SPEC §8.1. Pure: the same input always gives the same score, breakdown and reasons. No model is ever involved.

export interface ScoreInput {
  origin: 'evidence' | 'reference';
  modality: string;
  /** Verification tier of the source (T0 = never verified). */
  tier: Tier | undefined;
  lastVerifiedAt?: string;
  lastEditedAt: string;
  validUntil?: string;
  /** A: authority of the source (0–1). */
  authority: number;
  /** O: the owner, or null when there is none. */
  owner: { active: boolean } | null;
  /** C: independent groups (other than this claim's own) that state the same value. */
  agreeingGroups: number;
  /** I: share of claims changed since the last verification, or null when unknown. */
  driftRatio: number | null;
  /** U: resolved / reopened tickets that used this source. */
  usage: { resolved: number; reopened: number };
  /** An OrgEvent (law change, indexation, CAO update…) invalidated it after its last verification. */
  invalidatedByEvent: boolean;
  /** Neither the claim nor its document states a country. */
  scopeUndeclared: boolean;
  /** A copy of another source: context only. */
  derived: boolean;
  /** Severity of an open conflict this claim is a party to (null = none, or exempt as the provisional winner). */
  conflict: Severity | null;
  /** Gates imposed by ladder rules (a superseded or older-duplicate claim). */
  ruleGates: ('superseded' | 'duplicate_older')[];
}

export interface ScoreCtx {
  now: Date;
  halfLifeDays: number;
  cfg: ScoringConfig;
}

export interface ClaimScoreResult {
  score: number;
  breakdown: ScoreBreakdown;
  reasons: Reason[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const r = (code: ReasonCode, message: string): Reason => ({ code, message });

/** Beta-smoothed usage: (resolved + 1) / (resolved + reopened + 2); neutral without data. */
export function usageWeight(u: { resolved: number; reopened: number }, cfg: ScoringConfig): number {
  if (u.resolved + u.reopened === 0) return cfg.usage.neutral;
  return (u.resolved + 1) / (u.resolved + u.reopened + 2);
}

/** I = 1 − driftRatio; never verified → neutral; verified and unchanged → 1; edited after verification with unknown drift → neutral-ish. */
export function integrityWeight(i: Pick<ScoreInput, 'lastVerifiedAt' | 'lastEditedAt' | 'driftRatio'>, cfg: ScoringConfig): number {
  if (!i.lastVerifiedAt) return cfg.integrity.neverVerified;
  if (i.lastEditedAt <= i.lastVerifiedAt) return 1;
  return clamp01(1 - (i.driftRatio ?? 1 - cfg.integrity.unknownDrift));
}

/** C = min(1, 0.35 × independent agreeing groups). */
export const consensusWeight = (groups: number, cfg: ScoringConfig): number => Math.min(1, cfg.consensusPerGroup * Math.max(0, groups));

/** ConflictPenalty by severity: high −30, medium −15, low −5 (capped at −40). */
export const conflictPenalty = (severity: Severity | null, cfg: ScoringConfig): number => (severity ? Math.min(cfg.conflictPenalty.max, cfg.conflictPenalty[severity]) : 0);

export interface Gate {
  name: 'expired' | 'invalidated' | 'not_a_rule' | 'superseded' | 'duplicate_older';
  cap: number;
}

/** Hard gates, applied after the formula: the score can only go down to the lowest cap that applies. */
export function applyGates(score: number, gates: readonly Gate[]): { score: number; applied: string[] } {
  let out = score;
  const applied: string[] = [];
  for (const g of gates) {
    if (out > g.cap) out = g.cap;
    applied.push(`${g.name}≤${g.cap}`);
  }
  return { score: out, applied };
}

/**
 * ClaimScore = 100 × (0.30·V + 0.20·A + 0.15·O + 0.15·C + 0.10·I + 0.10·U) − ConflictPenalty, then the hard gates
 * (expired ≤10, superseded ≤20, invalidated-by-event ≤30 until re-verified, not-a-rule ≤25, older duplicate ≤20).
 * Every call returns the full breakdown and the reasons behind each component.
 */
export function claimScore(i: ScoreInput, ctx: ScoreCtx): ClaimScoreResult {
  const { cfg } = ctx;
  const w = cfg.weights;
  const reasons: Reason[] = [];

  const V = verificationWeight({ verifiedTier: i.tier, lastVerifiedAt: i.lastVerifiedAt }, ctx.now, ctx.halfLifeDays, cfg);
  const days = i.lastVerifiedAt ? Math.max(0, Math.floor((ctx.now.getTime() - new Date(i.lastVerifiedAt).getTime()) / DAY_MS)) : null;
  const decay = days === null ? null : 0.5 ** (days / ctx.halfLifeDays);
  const A = i.authority;
  const O = i.owner ? (i.owner.active ? cfg.ownership.active : cfg.ownership.inactive) : cfg.ownership.none;
  const C = consensusWeight(i.agreeingGroups, cfg);
  const I = integrityWeight(i, cfg);
  const U = usageWeight(i.usage, cfg);

  const expired = !!i.validUntil && new Date(i.validUntil).getTime() < ctx.now.getTime();
  const gates: Gate[] = [];
  if (expired) gates.push({ name: 'expired', cap: cfg.gates.expired });
  if (i.invalidatedByEvent) gates.push({ name: 'invalidated', cap: cfg.gates.invalidated });
  if (i.modality !== 'rule') gates.push({ name: 'not_a_rule', cap: cfg.gates.not_a_rule });
  for (const g of i.ruleGates) gates.push({ name: g, cap: cfg.gates[g] });

  // ---- reasons
  if (V === 0) reasons.push(r('UNVERIFIED', 'Never verified by an owner.'));
  else if (i.tier && decay !== null) {
    if (decay < 0.5) reasons.push(r('VERIFICATION_DECAYED', `Verified ${days} days ago (${i.tier}); more than one half-life has passed.`));
    else if (i.owner?.active) reasons.push(r('OWNER_VERIFIED', `Verified ${days} days ago (${i.tier}) by an active owner.`));
  }
  if (!i.owner) reasons.push(r('NO_OWNER', 'Nobody owns this source.'));
  else if (!i.owner.active) reasons.push(r('OWNER_INACTIVE', 'The owner has left: effectively orphaned.'));
  if (i.lastVerifiedAt && i.lastEditedAt > i.lastVerifiedAt) reasons.push(r('EDITED_AFTER_VERIFICATION', 'Edited after its last verification.'));
  if (A >= 1) reasons.push(r('AUTHORITATIVE_SOURCE', 'Authoritative source (law / collective agreement).'));
  if (i.agreeingGroups > 0) reasons.push(r('CORROBORATED_INDEPENDENT', `${i.agreeingGroups} independent source${i.agreeingGroups > 1 ? 's' : ''} state the same.`));
  if (expired) reasons.push(r('EXPIRED', 'The validity date has passed.'));
  if (i.invalidatedByEvent) reasons.push(r('INVALIDATED_BY_EVENT', 'A later law / indexation / CAO event invalidated it until it is re-verified.'));
  if (i.modality !== 'rule') reasons.push(r('NOT_A_RULE', `Stated as ${i.modality}, not as a binding rule.`));
  if (i.derived) reasons.push(r('DERIVED_COPY', 'A copy of another source: no independent credit.'));
  if (i.scopeUndeclared) reasons.push(r('SCOPE_UNDECLARED', 'Neither the claim nor its document states a country.'));
  if (i.origin === 'reference') reasons.push(r('REFERENCE_ONLY', 'Comes from the wiki (reference corpus).'));

  // ---- formula, penalty, gates
  const raw = 100 * (w.verification * V + w.authority * A + w.ownership * O + w.consensus * C + w.integrity * I + w.usage * U);
  const penalty = conflictPenalty(i.conflict, cfg);
  const gated = applyGates(Math.max(0, raw - penalty), gates);
  const total = round2(Math.max(0, Math.min(100, gated.score)));

  return {
    score: total,
    breakdown: { V: round2(clamp01(V)), A: round2(clamp01(A)), O: round2(clamp01(O)), C: round2(clamp01(C)), I: round2(clamp01(I)), U: round2(clamp01(U)), conflictPenalty: penalty, gates: gated.applied, total },
    reasons,
  };
}
