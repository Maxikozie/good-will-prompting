import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { TierSchema } from '../domain';
import { SCORING_FILE } from '../scoring/config';

export const LADDER_IDS = ['1_scope_split', '2_duplicate_older', '3_authority', '4_temporal_supersession', '5_newer_but_unverified', '6_consensus', '7_escalate'] as const;
export type LadderId = (typeof LADDER_IDS)[number];

const step = z.object({ id: z.string(), when: z.string().min(1), then: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() });

export const RulesConfigSchema = z
  .object({
    version: z.number().int(),
    status: z.object({ verifiedMinTier: TierSchema, verifiedMinDecay: z.number().min(0).max(1), likelyMinConfidence: z.number().min(0).max(100) }),
    ladder: z.array(step),
  })
  .superRefine((cfg, ctx) => {
    const ids = cfg.ladder.map((s) => s.id);
    if (ids.join() !== LADDER_IDS.join()) ctx.addIssue({ code: 'custom', message: `ladder must be exactly ${LADDER_IDS.join(' → ')}, got ${ids.join(' → ')}`, path: ['ladder'] });
  });
export type RulesConfig = z.infer<typeof RulesConfigSchema>;

export const RULES_FILE = path.resolve(import.meta.dirname, '..', '..', 'rules', 'rules.yaml');

/** Rule parameters, validated per rule. */
export interface LadderParams {
  strongTier: z.infer<typeof TierSchema>;
  strongAuthority: number;
  conflictSeverity5: 'medium' | 'low' | 'high';
  statusCap5: 'LIKELY' | 'PROVISIONAL';
  minIndependentGroups: number;
  minScoreGap: number;
  statusCap6: 'LIKELY' | 'PROVISIONAL';
  conflictSeverity7: 'high' | 'medium' | 'low';
}

const paramsSchemas = {
  '3_authority': z.object({ strongTier: TierSchema, strongAuthority: z.number().min(0).max(1) }),
  '5_newer_but_unverified': z.object({ conflictSeverity: z.enum(['high', 'medium', 'low']), statusCap: z.enum(['LIKELY', 'PROVISIONAL']) }),
  '6_consensus': z.object({ minIndependentGroups: z.number().int().min(2), minScoreGap: z.number().min(0), statusCap: z.enum(['LIKELY', 'PROVISIONAL']) }),
  '7_escalate': z.object({ conflictSeverity: z.enum(['high', 'medium', 'low']) }),
};

export interface Rules {
  config: RulesConfig;
  params: LadderParams;
  /** sha256 over rules.yaml and scoring.yaml (first 16 hex chars): stored on every CaseRun. */
  version: string;
}

let cached: Rules | undefined;

/** Load and zod-validate rules.yaml (ids, order, parameters) and scoring.yaml's presence; the hash covers both files. */
export function loadRules(rulesFile = RULES_FILE, scoringFile = SCORING_FILE): Rules {
  const isDefault = rulesFile === RULES_FILE && scoringFile === SCORING_FILE;
  if (isDefault && cached) return cached;
  const rulesText = fs.readFileSync(rulesFile, 'utf8');
  const config = RulesConfigSchema.parse(parse(rulesText));
  const p = (id: keyof typeof paramsSchemas) => paramsSchemas[id].parse(config.ladder.find((s) => s.id === id)?.params);
  const three = p('3_authority') as z.infer<(typeof paramsSchemas)['3_authority']>;
  const five = p('5_newer_but_unverified') as z.infer<(typeof paramsSchemas)['5_newer_but_unverified']>;
  const six = p('6_consensus') as z.infer<(typeof paramsSchemas)['6_consensus']>;
  const seven = p('7_escalate') as z.infer<(typeof paramsSchemas)['7_escalate']>;
  const version = createHash('sha256').update(rulesText).update('\n--\n').update(fs.readFileSync(scoringFile, 'utf8')).digest('hex').slice(0, 16);
  const rules: Rules = {
    config,
    version,
    params: {
      strongTier: three.strongTier, strongAuthority: three.strongAuthority,
      conflictSeverity5: five.conflictSeverity, statusCap5: five.statusCap,
      minIndependentGroups: six.minIndependentGroups, minScoreGap: six.minScoreGap, statusCap6: six.statusCap,
      conflictSeverity7: seven.conflictSeverity,
    },
  };
  if (isDefault) cached = rules;
  return rules;
}

/** rulesVersion = hash of rules.yaml + scoring.yaml. */
export const rulesVersion = (): string => loadRules().version;
