import type { EvidenceDocument, Tier } from '../domain';
import type { ScoringConfig } from './config';

// Building blocks of the claim score (SPEC §8.1) that are known BEFORE adjudication: verification (with decay),
// authority and ownership. Stage 60 adds consensus, integrity, usage, conflict penalty and the hard gates on top of these.

export const DAY_MS = 86_400_000;

/** V = tierWeight × 0.5^(daysSinceVerified / halfLifeDays). Unverified (no tier or no date) = 0. */
export function verificationWeight(doc: Pick<EvidenceDocument, 'verifiedTier' | 'lastVerifiedAt'>, now: Date, halfLifeDays: number, cfg: ScoringConfig): number {
  if (!doc.verifiedTier || !doc.lastVerifiedAt) return 0;
  const days = Math.max(0, (now.getTime() - new Date(doc.lastVerifiedAt).getTime()) / DAY_MS);
  const tier: Tier = doc.verifiedTier;
  return cfg.tierWeights[tier] * 0.5 ** (days / halfLifeDays);
}

/** O: active owner 1.0 · inactive owner 0.4 · none 0.2. */
export function ownershipWeight(owner: { active: boolean } | null | undefined, cfg: ScoringConfig): number {
  if (!owner) return cfg.ownership.none;
  return owner.active ? cfg.ownership.active : cfg.ownership.inactive;
}

/** A for evidence documents. A SharePoint document with an active owner and a verification counts as an owner-maintained policy. */
export function evidenceAuthority(doc: Pick<EvidenceDocument, 'sourceSystem' | 'lastVerifiedAt'>, ownerActive: boolean, cfg: ScoringConfig): number {
  const a = cfg.authority.evidence;
  switch (doc.sourceSystem) {
    case 'sharepoint':
      return ownerActive && doc.lastVerifiedAt ? a.owner_policy : a.sharepoint;
    case 'manual':
      return a.manual;
    case 'ticket':
      return a.ticket;
    case 'teams':
      return a.teams;
    case 'email':
      return a.email;
    default:
      return a.other;
  }
}

/**
 * Claim score from the components known before adjudication, rescaled to 0–100:
 * 100 × (wV·V + wA·A + wO·O) / (wV + wA + wO). Used by stage 40 (WEAK_SUPPORT); the final ClaimScore is computed in stage 60.
 */
export function knownComponentScore(v: { V: number; A: number; O: number }, cfg: ScoringConfig): number {
  const w = cfg.weights;
  return (100 * (w.verification * v.V + w.authority * v.A + w.ownership * v.O)) / (w.verification + w.authority + w.ownership);
}
