import { z } from 'zod';
import { ScoreBreakdownSchema } from './verdict';
import { FactStatusSchema, ReasonCodeSchema, ReasonSchema, SourceKindSchema } from './enums';
import { ClaimIdSchema, FactIdSchema, RunIdSchema, SourceIdSchema } from './ids';

/** Stored per claim and run (SPEC §8.1 "ClaimScore 0–100, stored"): the score, its full breakdown and the reasons behind it. */
export const ClaimScoreRowSchema = z.object({
  runId: RunIdSchema,
  claimId: ClaimIdSchema,
  sourceKind: SourceKindSchema,
  sourceId: SourceIdSchema,
  factId: FactIdSchema,
  role: z.enum(['winner', 'support', 'rejected', 'context']),
  /** Why it was rejected / set aside (REJECTED is a per-claim label, SPEC §6). */
  code: ReasonCodeSchema.optional(),
  score: z.number().min(0).max(100),
  breakdown: ScoreBreakdownSchema,
  reasons: z.array(ReasonSchema),
}).strict();
export type ClaimScoreRow = z.infer<typeof ClaimScoreRowSchema>;

/** Which ladder rules fired for a fact, and what the decision left to do (correction tasks, owners to ask). */
export const FactDecisionSchema = z.object({
  runId: RunIdSchema,
  factId: FactIdSchema,
  rulesVersion: z.string().max(100),
  fired: z.array(z.object({ id: z.string(), applies: z.boolean(), reasons: z.array(ReasonSchema) }).strict()),
  decidedBy: z.string().nullable(),
  cap: FactStatusSchema.optional(),
  correctionFor: z.array(ClaimIdSchema),
  escalateTo: z.array(ClaimIdSchema),
  scopeFit: z.number().min(0).max(1),
  independentCorroborations: z.number().int().min(0),
}).strict();
export type FactDecision = z.infer<typeof FactDecisionSchema>;
