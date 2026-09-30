import {
  classifyPair,
  type ClaimValue,
  type ConflictType,
  type FactStatus,
  type PairSide,
  type PartialScope,
  type Reason,
  type ReasonCode,
  type ScoreBreakdown,
  type Scope,
  type Severity,
  type Tier,
} from '../domain';
import { claimScore, factConfidence, scopeFit, type ScoreInput, type ScoringConfig } from '../scoring';
import type { LadderId, Rules } from './ladder-config';

// SPEC §7: the adjudication ladder. Every rule is a pure function (state, ctx) → {applies, outcome, reasons}; adjudicateFact runs
// them in order, applies each outcome, and records which rules fired. No database, no model, no clock but ctx.now.

export const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 4 };
const rank = (t: Tier | undefined) => (t ? TIER_RANK[t] : 0);

/** One claim (evidence claim or reference fact) taking part in a fact, with everything the rules and the score need. */
export interface Cand {
  id: string;
  origin: 'evidence' | 'reference';
  sourceId: string;
  /** Independence group of its source (copies share one). */
  group: string;
  value: ClaimValue;
  polarity: 'affirms' | 'negates';
  conditions: string[];
  modality: string;
  scope: PartialScope;
  scopeUndeclared: boolean;
  tier?: Tier;
  lastVerifiedAt?: string;
  lastEditedAt: string;
  validUntil?: string;
  effectiveFrom?: string;
  authority: number;
  owner: { active: boolean } | null;
  /** Person id of the owner (for correction tasks and escalation). */
  ownerId?: string;
  driftRatio: number | null;
  usage: { resolved: number; reopened: number };
  invalidatedByEvent: boolean;
}

export interface FactInput {
  factId: string;
  impact: 'high' | 'medium' | 'low';
  halfLifeDays: number;
  query: Scope;
  /** In scope, rule claims, not copies: they compete and support. */
  candidates: Cand[];
  /** Kept for the record, never compete: non-rule claims and derived copies (their scores are still computed). */
  context: { cand: Cand; code: ReasonCode }[];
  /** Number of claims outside the query scope that belong to the same proposition (rule 1 fires when > 0). */
  scopeMismatched: number;
  /** Claims whose passages are DUPLICATE_OF each other (rule 2). */
  duplicates: [string, string][];
  /** Claim pairs stage 30 already judged to agree (free text). */
  agreeing: [string, string][];
}

export interface LadderCtx {
  rules: Rules;
  scoring: ScoringConfig;
  now: Date;
}

export interface ConflictDraft {
  type: ConflictType;
  severity: Severity;
  status: 'open' | 'resolved';
  resolution: string;
  resolvedBy?: 'rule';
  claimIds: string[];
}

export interface RuleOutcome {
  rejected: { id: string; code: ReasonCode }[];
  supersedes: { newer: string; older: string }[];
  conflicts: ConflictDraft[];
  cap?: FactStatus;
  /** Claims whose owner gets a correction task (rule 3). */
  correctionFor: string[];
  /** Claims whose owners must be asked (rule 7). */
  escalateTo: string[];
  disputed: boolean;
}

export interface RuleResult {
  applies: boolean;
  outcome: RuleOutcome;
  reasons: Reason[];
}

export const noOutcome = (): RuleOutcome => ({ rejected: [], supersedes: [], conflicts: [], correctionFor: [], escalateTo: [], disputed: false });
const none = (): RuleResult => ({ applies: false, outcome: noOutcome(), reasons: [] });
const reason = (code: ReasonCode, message: string): Reason => ({ code, message });

// ---------------------------------------------------------------- positions: candidates that state the same value

export interface Position {
  cands: Cand[];
}

const side = (c: Cand): PairSide => ({ value: c.value, polarity: c.polarity, conditions: c.conditions, effectiveFrom: c.effectiveFrom });

/** Group candidates into positions: two candidates share one when their values agree (code, or stage 30's judgement for free text). */
export function positionsOf(cands: readonly Cand[], agreeing: readonly (readonly [string, string])[]): Position[] {
  const pairs = new Set(agreeing.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  const parent = new Map(cands.map((c) => [c.id, c.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i]!;
      const b = cands[j]!;
      const v = classifyPair(side(a), side(b));
      if (v.kind === 'agree' || v.kind === 'refine' || pairs.has(`${a.id}|${b.id}`)) {
        const ra = find(a.id);
        const rb = find(b.id);
        if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
      }
    }
  }
  const byRoot = new Map<string, Cand[]>();
  for (const c of cands) (byRoot.get(find(c.id)) ?? byRoot.set(find(c.id), []).get(find(c.id))!).push(c);
  return [...byRoot.values()].map((cs) => ({ cands: cs.sort((a, b) => a.id.localeCompare(b.id)) })).sort((a, b) => a.cands[0]!.id.localeCompare(b.cands[0]!.id));
}

export interface RuleState {
  /** Candidates still in the running. */
  live: Cand[];
  /** Base scores (formula without conflict penalty and rule gates). */
  base: ReadonlyMap<string, number>;
  positions: Position[];
  input: FactInput;
}

const ids = (cs: readonly Cand[]) => cs.map((c) => c.id);
const groupsOf = (p: Position) => new Set(p.cands.filter((c) => c.origin === 'evidence' || c.origin === 'reference').map((c) => c.group));
const strength = (p: Position, base: ReadonlyMap<string, number>) => Math.max(...p.cands.map((c) => base.get(c.id) ?? 0));
const time = (iso: string | undefined) => (iso ? new Date(iso).getTime() : Number.NaN);
/** Key date of a claim for rule 4: its effective date, else its last verification. */
const keyDate = (c: Cand) => time(c.effectiveFrom ?? c.lastVerifiedAt);

// ---------------------------------------------------------------- the seven rules

/** 1 — scope split: claims that differ only in scope keys are not in conflict; only claims matching the query scope compete. */
export function rule1ScopeSplit(st: RuleState): RuleResult {
  if (st.input.scopeMismatched <= 0) return none();
  return { applies: true, outcome: noOutcome(), reasons: [reason('SCOPE_MISMATCH', `${st.input.scopeMismatched} claim(s) about another scope (country / committee / category) were set aside, not treated as a conflict.`)] };
}

/** 2 — duplicate of an older version: the older claim is rejected; the newer inherits it as support, never as an independent source. */
export function rule2DuplicateOlder(st: RuleState): RuleResult {
  const byId = new Map(st.live.map((c) => [c.id, c]));
  const rejected = new Map<string, ReasonCode>();
  for (const [x, y] of st.input.duplicates) {
    const a = byId.get(x);
    const b = byId.get(y);
    if (!a || !b || a.sourceId === b.sourceId) continue;
    const ta = time(a.lastEditedAt);
    const tb = time(b.lastEditedAt);
    if (ta === tb) continue; // same version: not an older copy
    rejected.set((ta < tb ? a : b).id, 'DUPLICATE_OLDER_VERSION');
  }
  if (!rejected.size) return none();
  return {
    applies: true,
    outcome: { ...noOutcome(), rejected: [...rejected].map(([id, code]) => ({ id, code })).sort((a, b) => a.id.localeCompare(b.id)) },
    reasons: [reason('DUPLICATE_OLDER_VERSION', 'An older version of the same text was set aside; the newer one inherits it as support, not as an independent source.')],
  };
}

/** 3 — authority: exactly one side has tier T4 or authority 1.0: that side wins, the other is rejected and its owner gets a correction task. */
export function rule3Authority(st: RuleState, ctx: LadderCtx): RuleResult {
  if (st.positions.length < 2) return none();
  const { strongTier, strongAuthority } = ctx.rules.params;
  const strong = st.positions.filter((p) => p.cands.some((c) => c.tier === strongTier || c.authority >= strongAuthority));
  if (strong.length !== 1) return none();
  const losers = st.positions.filter((p) => p !== strong[0]).flatMap((p) => p.cands);
  return {
    applies: true,
    outcome: {
      ...noOutcome(),
      rejected: losers.map((c) => ({ id: c.id, code: 'CONTRADICTED_BY_AUTHORITY' as const })),
      correctionFor: losers.filter((c) => c.ownerId).map((c) => c.id),
      conflicts: [{ type: 'value', severity: 'high', status: 'resolved', resolvedBy: 'rule', resolution: '3_authority', claimIds: ids(st.live) }],
    },
    reasons: [reason('AUTHORITATIVE_SOURCE', 'One side is an authoritative source (tier T4 / law or collective agreement); the other side needs correcting.'), reason('CONTRADICTED_BY_AUTHORITY', 'Contradicted by an authoritative source.')],
  };
}

/**
 * 4 — temporal supersession: same scope, the newer claim has a later effective date / verification than the older one and at least
 * its tier → newer SUPERSEDES older; the older is rejected (and capped by the superseded gate). "Newer" follows the effective dates when
 * both have one, otherwise the document's last edit: an unverified newer edit has no key date and never supersedes (that is rule 5).
 */
export function rule4TemporalSupersession(st: RuleState): RuleResult {
  if (st.positions.length < 2) return none();
  const posOf = new Map(st.positions.flatMap((p, i) => p.cands.map((c) => [c.id, i] as const)));
  const superseded = new Map<string, string>(); // older → newer
  const newerThan = (n: Cand, o: Cand) => {
    const bothDated = n.effectiveFrom && o.effectiveFrom;
    return bothDated ? time(n.effectiveFrom) > time(o.effectiveFrom) : time(n.lastEditedAt) > time(o.lastEditedAt);
  };
  for (const n of st.live) {
    for (const o of st.live) {
      if (n.id === o.id || posOf.get(n.id) === posOf.get(o.id) || !newerThan(n, o)) continue;
      const kn = keyDate(n);
      const ko = keyDate(o);
      if (Number.isNaN(kn) || (!Number.isNaN(ko) && kn <= ko)) continue;
      if (rank(n.tier) < rank(o.tier)) continue;
      const prev = superseded.get(o.id);
      if (!prev || keyDate(n) > keyDate(st.live.find((x) => x.id === prev)!)) superseded.set(o.id, n.id);
    }
  }
  if (!superseded.size) return none();
  const pairs = [...superseded].map(([older, newer]) => ({ older, newer })).sort((a, b) => a.older.localeCompare(b.older));
  return {
    applies: true,
    outcome: {
      ...noOutcome(),
      rejected: pairs.map((p) => ({ id: p.older, code: 'SUPERSEDED_TEMPORAL' as const })),
      supersedes: pairs,
      conflicts: pairs.map((p) => ({ type: 'temporal' as const, severity: 'high' as const, status: 'resolved' as const, resolvedBy: 'rule' as const, resolution: '4_temporal_supersession', claimIds: [p.newer, p.older] })),
    },
    reasons: [reason('SUPERSEDED_TEMPORAL', 'A newer claim with an equal or better verification replaced the older one.')],
  };
}

/** 5 — newest ≠ correct: a claim that is newer by last edit but has a LOWER verification tier loses provisionally; the conflict stays open. */
export function rule5NewerButUnverified(st: RuleState, ctx: LadderCtx): RuleResult {
  if (st.positions.length < 2) return none();
  const posOf = new Map(st.positions.flatMap((p, i) => p.cands.map((c) => [c.id, i] as const)));
  const against = new Map<string, Set<string>>(); // flagged claim → the better verified, older claims it lost against
  for (const n of st.live) {
    for (const o of st.live) {
      if (n.id !== o.id && posOf.get(n.id) !== posOf.get(o.id) && time(n.lastEditedAt) > time(o.lastEditedAt) && rank(n.tier) < rank(o.tier)) {
        (against.get(n.id) ?? against.set(n.id, new Set()).get(n.id)!).add(o.id);
      }
    }
  }
  if (!against.size) return none();
  const conflicts: ConflictDraft[] = [];
  for (const p of st.positions) {
    const mine = p.cands.filter((c) => against.has(c.id));
    if (!mine.length) continue;
    const anchorIds = new Set(mine.flatMap((c) => [...against.get(c.id)!]));
    const anchors = st.positions.filter((q) => q.cands.some((c) => anchorIds.has(c.id))).flatMap((q) => q.cands.filter((c) => !against.has(c.id)));
    conflicts.push({ type: 'value', severity: ctx.rules.params.conflictSeverity5, status: 'open', resolution: '5_newer_but_unverified', claimIds: [...ids(mine), ...ids(anchors)] });
  }
  return {
    applies: true,
    outcome: { ...noOutcome(), rejected: [...against.keys()].sort().map((id) => ({ id, code: 'NEWER_BUT_UNVERIFIED' as const })), conflicts, cap: ctx.rules.params.statusCap5 },
    reasons: [reason('NEWER_BUT_UNVERIFIED', 'A newer edit exists but nobody verified it: the verified older claim wins provisionally until an owner decides.')],
  };
}

/** 6 — consensus: ≥ N independent groups agree and their best score beats every dissent by the gap → majority wins, dissent rejected. */
export function rule6Consensus(st: RuleState, ctx: LadderCtx): RuleResult {
  if (st.positions.length < 2) return none();
  const { minIndependentGroups, minScoreGap, statusCap6 } = ctx.rules.params;
  const ranked = [...st.positions].sort((a, b) => groupsOf(b).size - groupsOf(a).size || strength(b, st.base) - strength(a, st.base));
  const major = ranked.find((p) => groupsOf(p).size >= minIndependentGroups && st.positions.filter((q) => q !== p).every((q) => strength(p, st.base) - strength(q, st.base) >= minScoreGap));
  if (!major) return none();
  const dissent = st.positions.filter((p) => p !== major);
  return {
    applies: true,
    outcome: {
      ...noOutcome(),
      rejected: dissent.flatMap((p) => p.cands).map((c) => ({ id: c.id, code: 'CONTRADICTED_BY_CONSENSUS' as const })),
      conflicts: dissent.map((p) => ({ type: 'value' as const, severity: 'high' as const, status: 'resolved' as const, resolvedBy: 'rule' as const, resolution: '6_consensus', claimIds: [...ids(major.cands), ...ids(p.cands)] })),
      cap: statusCap6,
    },
    reasons: [reason('CONTRADICTED_BY_CONSENSUS', `${groupsOf(major).size} independent sources agree and outscore the dissent; capped until an owner confirms.`)],
  };
}

/** 7 — escalate: still contradicting → DISPUTED, and the owners of every contradicting claim are asked. */
export function rule7Escalate(st: RuleState, ctx: LadderCtx): RuleResult {
  if (st.positions.length < 2) return none();
  return {
    applies: true,
    outcome: {
      ...noOutcome(),
      disputed: true,
      conflicts: [{ type: 'value', severity: ctx.rules.params.conflictSeverity7, status: 'open', resolution: '7_escalate', claimIds: ids(st.live) }],
      escalateTo: st.live.filter((c) => c.ownerId).map((c) => c.id),
    },
    reasons: [],
  };
}

export const LADDER: { id: LadderId; run: (st: RuleState, ctx: LadderCtx) => RuleResult }[] = [
  { id: '1_scope_split', run: rule1ScopeSplit },
  { id: '2_duplicate_older', run: rule2DuplicateOlder },
  { id: '3_authority', run: rule3Authority },
  { id: '4_temporal_supersession', run: rule4TemporalSupersession },
  { id: '5_newer_but_unverified', run: rule5NewerButUnverified },
  { id: '6_consensus', run: rule6Consensus },
  { id: '7_escalate', run: rule7Escalate },
];

// ---------------------------------------------------------------- status (SPEC §6)

export interface StatusInput {
  hasWinner: boolean;
  disputed: boolean;
  winnerOrigin?: 'evidence' | 'reference';
  winnerTier?: Tier;
  /** 0.5^(days/halfLife) of the winner's verification, or null when unverified. */
  decay: number | null;
  expired: boolean;
  /** An OrgEvent invalidated the winner after its last verification: the verification no longer counts (SPEC §8.1 gate, §11 alert). */
  invalidated?: boolean;
  confidence: number;
  openHighConflict: boolean;
  cap?: FactStatus;
  impact: 'high' | 'medium' | 'low';
}

const STATUS_ORDER: FactStatus[] = ['VERIFIED', 'LIKELY', 'PROVISIONAL'];

/**
 * Status exactly per SPEC §6:
 *  VERIFIED   winner tier ≥ T3, not decayed below 0.5, not expired, not invalidated by an OrgEvent, no open high-severity conflict
 *  LIKELY     confidence ≥ 70 and no open high-severity conflict
 *  DISPUTED   an unresolved contradiction after the ladder (rule 7)
 *  PROVISIONAL supported only by reference facts, or anything else that has a winner but not the strength for LIKELY
 *  UNKNOWN    nothing left to answer with
 * needsVerification = DISPUTED | PROVISIONAL | (LIKELY and impact high). A cap from rules 5/6 lowers VERIFIED to LIKELY.
 */
export function assignStatus(i: StatusInput, rules: Rules): { status: FactStatus; needsVerification: boolean } {
  let status: FactStatus;
  if (!i.hasWinner) status = i.disputed ? 'DISPUTED' : 'UNKNOWN';
  else if (i.winnerOrigin === 'reference') status = 'PROVISIONAL'; // the wiki alone never goes higher
  else if (rank(i.winnerTier) >= TIER_RANK[rules.config.status.verifiedMinTier] && (i.decay ?? 0) >= rules.config.status.verifiedMinDecay && !i.expired && !i.invalidated && !i.openHighConflict) status = 'VERIFIED';
  else if (i.confidence >= rules.config.status.likelyMinConfidence && !i.openHighConflict) status = 'LIKELY';
  else status = 'PROVISIONAL';
  if (i.cap && STATUS_ORDER.includes(status) && STATUS_ORDER.indexOf(status) < STATUS_ORDER.indexOf(i.cap)) status = i.cap;
  const needsVerification = status === 'DISPUTED' || status === 'PROVISIONAL' || (status === 'LIKELY' && i.impact === 'high');
  return { status, needsVerification };
}

// ---------------------------------------------------------------- adjudicateFact

export interface ClaimOutcome {
  id: string;
  origin: 'evidence' | 'reference';
  role: 'winner' | 'support' | 'rejected' | 'context';
  code?: ReasonCode;
  score: number;
  breakdown: ScoreBreakdown;
  reasons: Reason[];
}

export interface FactResult {
  winnerId?: string;
  winningValue?: ClaimValue;
  status: FactStatus;
  confidence: number;
  needsVerification: boolean;
  reasons: Reason[];
  conflicts: ConflictDraft[];
  claims: ClaimOutcome[];
  /** Every rule in ladder order with whether it applied, and its reasons. */
  fired: { id: LadderId; applies: boolean; reasons: Reason[] }[];
  /** The rule that settled (or escalated) the contradiction; null when there was none. */
  decidedBy: LadderId | null;
  cap?: FactStatus;
  correctionFor: string[];
  escalateTo: string[];
  supersedes: { newer: string; older: string }[];
  scopeFit: number;
  independentCorroborations: number;
}

const scoreInput = (c: Cand, agreeingGroups: number, extra: Pick<ScoreInput, 'conflict' | 'ruleGates' | 'derived'>): ScoreInput => ({
  origin: c.origin, modality: c.modality, tier: c.tier, lastVerifiedAt: c.lastVerifiedAt, lastEditedAt: c.lastEditedAt, validUntil: c.validUntil, authority: c.authority, owner: c.owner,
  agreeingGroups, driftRatio: c.driftRatio, usage: c.usage, invalidatedByEvent: c.invalidatedByEvent, scopeUndeclared: c.scopeUndeclared, ...extra,
});

const SEVERITY_ORDER: Severity[] = ['low', 'medium', 'high'];
const worst = (a: Severity | null, b: Severity) => (a === null || SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a);

/** Run the ladder on one fact: positions → component scores → rules 1..7 in order → winner → penalties and gates → confidence → status. */
export function adjudicateFact(input: FactInput, ctx: LadderCtx): FactResult {
  const { scoring } = ctx;
  const scoreCtx = { now: ctx.now, halfLifeDays: input.halfLifeDays, cfg: scoring };

  // positions over everything that competes, and each candidate's base score (consensus C comes from the positions)
  const initial = positionsOf(input.candidates, input.agreeing);
  const agreeingGroups = new Map<string, number>();
  for (const p of initial) for (const c of p.cands) agreeingGroups.set(c.id, new Set(p.cands.filter((o) => o.group !== c.group).map((o) => o.group)).size);
  const base = new Map(input.candidates.map((c) => [c.id, claimScore(scoreInput(c, agreeingGroups.get(c.id) ?? 0, { conflict: null, ruleGates: [], derived: false }), scoreCtx).score]));

  // ---- the ladder
  let live = [...input.candidates];
  const rejected = new Map<string, ReasonCode>();
  const conflicts: ConflictDraft[] = [];
  const fired: FactResult['fired'] = [];
  const supersedes: FactResult['supersedes'] = [];
  const correctionFor: string[] = [];
  const escalateTo: string[] = [];
  const reasons: Reason[] = [];
  let cap: FactStatus | undefined;
  let disputed = false;
  let decidedBy: LadderId | null = null;
  for (const { id, run } of LADDER) {
    const st: RuleState = { live, base, positions: positionsOf(live, input.agreeing), input };
    const res = run(st, ctx);
    fired.push({ id, applies: res.applies, reasons: res.reasons });
    if (!res.applies) continue;
    const o = res.outcome;
    for (const r of o.rejected) rejected.set(r.id, r.code);
    live = live.filter((c) => !o.rejected.some((r) => r.id === c.id));
    conflicts.push(...o.conflicts);
    supersedes.push(...o.supersedes);
    correctionFor.push(...o.correctionFor);
    escalateTo.push(...o.escalateTo);
    reasons.push(...res.reasons);
    if (o.cap) cap = o.cap;
    if (o.disputed) disputed = true;
    if (o.conflicts.length) decidedBy = id;
  }

  // ---- the winner: best eligible candidate of the single remaining position (evidence before reference)
  const finalPositions = positionsOf(live, input.agreeing);
  const winnerPosition = !disputed && finalPositions.length === 1 ? finalPositions[0]! : undefined;
  const pick = (cs: Cand[]) => [...cs].sort((a, b) => (base.get(b.id) ?? 0) - (base.get(a.id) ?? 0) || a.id.localeCompare(b.id))[0];
  const winner = winnerPosition && (pick(winnerPosition.cands.filter((c) => c.origin === 'evidence')) ?? pick(winnerPosition.cands));
  // a disputed fact has no winner: every live claim keeps supporting its own position
  const inWinnerPosition = new Set(winnerPosition ? ids(winnerPosition.cands) : disputed ? ids(live) : []);

  // ---- final scores: open conflicts penalise their parties (the provisional winner of rule 5 is exempt), rule gates cap the rejected
  const penalty = new Map<string, Severity>();
  for (const c of conflicts.filter((x) => x.status === 'open')) {
    for (const id of c.claimIds) {
      if (c.resolution === '5_newer_but_unverified' && inWinnerPosition.has(id)) continue;
      penalty.set(id, worst(penalty.get(id) ?? null, c.severity));
    }
  }
  const claims: ClaimOutcome[] = [];
  const outcomeFor = (c: Cand, role: ClaimOutcome['role'], code: ReasonCode | undefined, derived: boolean) => {
    const gates: ScoreInput['ruleGates'] = code === 'SUPERSEDED_TEMPORAL' ? ['superseded'] : code === 'DUPLICATE_OLDER_VERSION' ? ['duplicate_older'] : [];
    const res = claimScore(scoreInput(c, agreeingGroups.get(c.id) ?? 0, { conflict: penalty.get(c.id) ?? null, ruleGates: gates, derived }), scoreCtx);
    const reasonsOut = [...res.reasons];
    if (code && !reasonsOut.some((r) => r.code === code)) reasonsOut.push(reason(code, describe(code)));
    claims.push({ id: c.id, origin: c.origin, role, ...(code ? { code } : {}), score: res.score, breakdown: res.breakdown, reasons: reasonsOut });
    return res.score;
  };
  let winnerScore = 0;
  for (const c of input.candidates) {
    const code = rejected.get(c.id);
    const role: ClaimOutcome['role'] = c.id === winner?.id ? 'winner' : code ? 'rejected' : inWinnerPosition.has(c.id) ? 'support' : 'rejected';
    const s = outcomeFor(c, role, code, false);
    if (role === 'winner') winnerScore = s;
  }
  for (const { cand, code } of input.context) outcomeFor(cand, 'context', code, code === 'DERIVED_COPY');

  // ---- confidence and status
  const independent = winnerPosition && winner ? new Set(winnerPosition.cands.filter((c) => c.group !== winner.group).map((c) => c.group)).size : 0;
  const fit = winner ? scopeFit(winner.scope, input.query, scoring) : 0;
  const confidence = winner ? factConfidence(winnerScore, independent, fit, scoring) : 0;
  const days = winner?.lastVerifiedAt ? Math.max(0, (ctx.now.getTime() - new Date(winner.lastVerifiedAt).getTime()) / 86_400_000) : null;
  const { status, needsVerification } = assignStatus(
    {
      hasWinner: !!winner, disputed, winnerOrigin: winner?.origin, winnerTier: winner?.tier, decay: days === null ? null : 0.5 ** (days / input.halfLifeDays),
      expired: !!winner?.validUntil && new Date(winner.validUntil).getTime() < ctx.now.getTime(), invalidated: !!winner?.invalidatedByEvent, confidence,
      openHighConflict: conflicts.some((c) => c.status === 'open' && c.severity === 'high'), cap, impact: input.impact,
    },
    ctx.rules,
  );

  const winnerReasons = claims.find((c) => c.id === winner?.id)?.reasons ?? [];
  const seen = new Set<string>();
  const factReasons = [...winnerReasons, ...reasons, ...(winner?.origin === 'reference' ? [reason('REFERENCE_ONLY', 'Only the wiki supports it: at most PROVISIONAL.')] : [])].filter((r) => !seen.has(r.code) && seen.add(r.code));

  return {
    ...(winner ? { winnerId: winner.id, winningValue: winner.value } : {}),
    status, confidence, needsVerification, reasons: factReasons, conflicts, claims, fired, decidedBy,
    ...(cap ? { cap } : {}), correctionFor, escalateTo, supersedes, scopeFit: fit, independentCorroborations: independent,
  };
}

function describe(code: ReasonCode): string {
  switch (code) {
    case 'DUPLICATE_OLDER_VERSION': return 'An older version of text that exists in a newer document.';
    case 'SUPERSEDED_TEMPORAL': return 'Replaced by a newer, at least as well verified claim.';
    case 'NEWER_BUT_UNVERIFIED': return 'Newer, but less verified than the claim it disagrees with.';
    case 'CONTRADICTED_BY_AUTHORITY': return 'Contradicted by an authoritative source.';
    case 'CONTRADICTED_BY_CONSENSUS': return 'Contradicted by independent sources that agree with each other.';
    case 'SCOPE_MISMATCH': return 'Applies to another scope than the question.';
    default: return code;
  }
}
