import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const unit = z.number().min(0).max(1);

export const ScoringConfigSchema = z.object({
  version: z.number().int(),
  weights: z.object({ verification: unit, authority: unit, ownership: unit, consensus: unit, integrity: unit, usage: unit }),
  tierWeights: z.object({ T0: unit, T1: unit, T2: unit, T3: unit, T4: unit }),
  authority: z.object({
    evidence: z.object({ law: unit, owner_policy: unit, sharepoint: unit, manual: unit, ticket: unit, teams: unit, email: unit, other: unit }),
    reference: z.object({ default: unit, official_owned: unit }),
  }),
  ownership: z.object({ active: unit, inactive: unit, none: unit }),
  consensusPerGroup: unit,
  conflictPenalty: z.object({ high: z.number().min(0), medium: z.number().min(0), low: z.number().min(0), max: z.number().min(0) }),
  gates: z.object({ expired: z.number(), superseded: z.number(), invalidated: z.number(), not_a_rule: z.number() }),
  bands: z.object({ trusted: z.number(), careful: z.number() }),
  weakSupport: z.object({ scoreBelow: z.number(), lowAuthorityBelow: unit }),
});
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

export const SCORING_FILE = path.resolve(import.meta.dirname, '..', '..', 'rules', 'scoring.yaml');

let cached: ScoringConfig | undefined;
export function loadScoringConfig(file = SCORING_FILE): ScoringConfig {
  if (file === SCORING_FILE && cached) return cached;
  const cfg = ScoringConfigSchema.parse(parse(fs.readFileSync(file, 'utf8')));
  const sum = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) throw new Error(`scoring weights must sum to 1, got ${sum}`);
  if (file === SCORING_FILE) cached = cfg;
  return cfg;
}
