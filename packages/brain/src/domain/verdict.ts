import { z } from 'zod';
import { AttributionSchema } from './brain-nodes';
import { SpanSchema, ClaimValueSchema } from './claim';
import { ConflictTypeSchema, FactStatusSchema, ReasonSchema, SeveritySchema, ConflictStatusSchema, SourceKindSchema, GapStatusSchema, GapTypeSchema, VerificationRequestStatusSchema } from './enums';
import { ClaimIdSchema, ConflictIdSchema, FactIdSchema, GapIdSchema, PersonIdSchema, ReferenceFactIdSchema, RunIdSchema, SourceIdSchema, VerificationRequestIdSchema } from './ids';
import { ScopeSchema } from './scope';

// SPEC §12 output contract.

const unit = z.number().min(0).max(1);

/** §8.1: every score returns its full breakdown. Components are 0..1, total 0..100. */
export const ScoreBreakdownSchema = z.object({
  V: unit, // verification
  A: unit, // authority
  O: unit, // ownership
  C: unit, // consensus
  I: unit, // integrity
  U: unit, // usage
  conflictPenalty: z.number().min(0).max(40),
  gates: z.array(z.string().max(100)), // hard gates applied after the formula
  total: z.number().min(0).max(100),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

/** §8.2 fact confidence. */
export const FactBreakdownSchema = z.object({
  winner: ScoreBreakdownSchema.nullable(),
  corroborationBonus: z.number().min(0).max(10),
  scopeFit: unit,
  confidence: z.number().min(0).max(100),
});
export type FactBreakdown = z.infer<typeof FactBreakdownSchema>;

export const CitationSchema = z.object({
  sourceKind: SourceKindSchema,
  sourceId: SourceIdSchema,
  title: z.string().max(300),
  quote: z.string().max(300),
  span: SpanSchema,
});
export type Citation = z.infer<typeof CitationSchema>;

export const AnswerSentenceSchema = z.object({ text: z.string().min(1).max(1000), factId: FactIdSchema, citations: z.array(CitationSchema) });
export type AnswerSentence = z.infer<typeof AnswerSentenceSchema>;

export const VerdictFactSchema = z.object({
  id: FactIdSchema,
  slotId: z.string().max(100).optional(),
  attribute: z.string().max(100),
  value: ClaimValueSchema.optional(),
  status: FactStatusSchema,
  confidence: z.number().min(0).max(100),
  breakdown: FactBreakdownSchema,
  reasons: z.array(ReasonSchema),
  needsVerification: z.boolean(),
});
export type VerdictFact = z.infer<typeof VerdictFactSchema>;

/** A claim as shown inside a conflict. */
export const ConflictClaimViewSchema = z.object({
  claimId: ClaimIdSchema,
  sourceKind: SourceKindSchema,
  sourceId: SourceIdSchema,
  title: z.string().max(300),
  value: ClaimValueSchema,
  score: z.number().min(0).max(100),
  quote: z.string().max(300),
});
export type ConflictClaimView = z.infer<typeof ConflictClaimViewSchema>;

export const VerdictConflictSchema = z.object({
  id: ConflictIdSchema,
  factId: FactIdSchema,
  type: ConflictTypeSchema,
  severity: SeveritySchema,
  claims: z.array(ConflictClaimViewSchema),
  resolution: z.string().max(500).optional(),
  status: ConflictStatusSchema,
});
export type VerdictConflict = z.infer<typeof VerdictConflictSchema>;

export const VerdictGapSchema = z.object({
  id: GapIdSchema,
  type: GapTypeSchema,
  slotId: z.string().max(100).optional(),
  status: GapStatusSchema,
  closedBy: z.array(ReferenceFactIdSchema).optional(),
});
export type VerdictGap = z.infer<typeof VerdictGapSchema>;

export const VerdictVerificationSchema = z.object({
  requestId: VerificationRequestIdSchema,
  factId: FactIdSchema,
  requestedFrom: z.object({ id: PersonIdSchema, name: z.string().max(200), team: z.string().max(200) }),
  status: VerificationRequestStatusSchema,
});
export type VerdictVerification = z.infer<typeof VerdictVerificationSchema>;

export const CaseVerdictSchema = z.object({
  runId: RunIdSchema,
  question: z.string().max(1000),
  scope: ScopeSchema,
  generatedSlots: z.boolean(),
  answer: z.object({ text: z.string().max(4000), sentences: z.array(AnswerSentenceSchema) }),
  facts: z.array(VerdictFactSchema),
  conflicts: z.array(VerdictConflictSchema),
  gaps: z.array(VerdictGapSchema),
  attribution: z.object({
    evidenceTotalPct: z.number().min(0).max(100),
    referenceTotalPct: z.number().min(0).max(100),
    sources: z.array(AttributionSchema),
  }),
  verification: z.array(VerdictVerificationSchema),
  versions: z.object({
    rulesVersion: z.string().max(100),
    promptVersions: z.record(z.string(), z.string()),
    modelIds: z.record(z.string(), z.string()),
  }),
});
export type CaseVerdict = z.infer<typeof CaseVerdictSchema>;

