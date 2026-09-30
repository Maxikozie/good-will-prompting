import path from 'node:path';
import { readYaml } from '../security/input';
import { z } from 'zod';

const unit = z.number().min(0).max(1);

export const ScoringConfigSchema = z.object({
  version: z.number().int(),
  weights: z.object({ verification: unit, authority: unit, ownership: unit, consensus: unit, integrity: unit, usage: unit }).strict(),
  tierWeights: z.object({ T0: unit, T1: unit, T2: unit, T3: unit, T4: unit }).strict(),
  authority: z.object({
    evidence: z.object({ law: unit, owner_policy: unit, sharepoint: unit, manual: unit, ticket: unit, teams: unit, email: unit, other: unit }).strict(),
    reference: z.object({ default: unit, official_owned: unit }).strict(),
  }).strict(),
  ownership: z.object({ active: unit, inactive: unit, none: unit }).strict(),
  consensusPerGroup: unit,
  conflictPenalty: z.object({ high: z.number().min(0), medium: z.number().min(0), low: z.number().min(0), max: z.number().min(0) }).strict(),
  gates: z.object({ expired: z.number(), superseded: z.number(), invalidated: z.number(), not_a_rule: z.number(), duplicate_older: z.number() }).strict(),
  bands: z.object({ trusted: z.number(), careful: z.number() }).strict(),
  weakSupport: z.object({ scoreBelow: z.number(), lowAuthorityBelow: unit }).strict(),
  halfLifeDays: z.number().positive(),
  reference: z.object({ verifiedTier: z.enum(['T0', 'T1', 'T2', 'T3', 'T4']) }).strict(),
  integrity: z.object({ neverVerified: unit, unknownDrift: unit }).strict(),
  usage: z.object({ neutral: unit }).strict(),
  corroboration: z.object({ bonus: z.number().min(0), forFullBonus: z.number().positive() }).strict(),
  scopeFit: z.object({ exact: unit, parent: unit, productUnknown: unit, otherCountry: unit }).strict(),
}).strict();
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

export const SCORING_FILE = path.resolve(import.meta.dirname, '..', '..', 'rules', 'scoring.yaml');

let cached: ScoringConfig | undefined;
export function loadScoringConfig(file = SCORING_FILE): ScoringConfig {
  if (file === SCORING_FILE && cached) return cached;
  const cfg = readYaml(file, ScoringConfigSchema);
  const sum = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`scoring weights must sum to 1, got ${sum}`);
  if (file === SCORING_FILE) cached = cfg;
  return cfg;
}
