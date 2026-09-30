import { z } from 'zod';
import { IsoStringSchema, ModalitySchema, PolaritySchema, UnitSchema, ValueTypeSchema } from './enums';
import {
  EvidenceClaimIdSchema,
  EvidenceDocIdSchema,
  EvidencePassageIdSchema,
  EvidenceSnapshotIdSchema,
  ReferenceFactIdSchema,
  WikiPageIdSchema,
  WikiSectionIdSchema,
  WikiSnapshotIdSchema,
} from './ids';
import { PartialScopeSchema } from './scope';

export const SpanSchema = z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).refine((s) => s.end >= s.start, 'span end < start');
export type Span = z.infer<typeof SpanSchema>;

export const ClaimValueSchema = z.object({
  type: ValueTypeSchema,
  raw: z.string().max(500),
  normalized: z.unknown(), // number | string | boolean | {min,max} | ISO date; produced by domain/normalize.ts, never by an LLM
  unit: UnitSchema.optional(),
});
export type ClaimValue = z.infer<typeof ClaimValueSchema>;

export const QualifiersSchema = PartialScopeSchema.extend({ conditions: z.array(z.string().max(300)).max(20) });
export type Qualifiers = z.infer<typeof QualifiersSchema>;

export const TemporalSchema = z.object({
  effectiveFrom: IsoStringSchema.optional(),
  effectiveTo: IsoStringSchema.optional(),
  statedAsOf: IsoStringSchema.optional(),
});
export type Temporal = z.infer<typeof TemporalSchema>;

// Shape shared by EvidenceClaim and ReferenceFact (SPEC §3). The per-origin objects only differ in branded ids.
const claimCommon = {
  span: SpanSchema,
  quote: z.string().min(1).max(300), // verbatim from the passage (anti-hallucination check in stage 20)
  subject: z.string().min(1).max(200), // canonical dotted id, e.g. "leave.small_leave.own_marriage"
  attribute: z.string().min(1).max(100), // duration | eligibility | timing_window | pay_continuation | …
  value: ClaimValueSchema,
  qualifiers: QualifiersSchema,
  temporal: TemporalSchema,
  polarity: PolaritySchema,
  modality: ModalitySchema,
  extractionConfidence: z.number().min(0).max(1),
  claimKey: z.string().regex(/^[a-f0-9]{40}$/), // sha1(subject|attribute|scopeKey)
  createdAt: IsoStringSchema,
};

export const EvidenceClaimSchema = z.object({
  id: EvidenceClaimIdSchema,
  namespace: z.literal('evidence'),
  origin: z.literal('evidence'),
  sourceId: EvidenceDocIdSchema,
  snapshotId: EvidenceSnapshotIdSchema,
  passageId: EvidencePassageIdSchema,
  ...claimCommon,
});
export type EvidenceClaim = z.infer<typeof EvidenceClaimSchema>;

export const ReferenceFactSchema = z.object({
  id: ReferenceFactIdSchema,
  namespace: z.literal('reference'),
  origin: z.literal('reference'),
  sourceId: WikiPageIdSchema,
  snapshotId: WikiSnapshotIdSchema,
  passageId: WikiSectionIdSchema, // the wiki equivalent of a passage is a section
  ...claimCommon,
});
export type ReferenceFact = z.infer<typeof ReferenceFactSchema>;

/** Discriminated by `origin`. */
export const ClaimSchema = z.discriminatedUnion('origin', [EvidenceClaimSchema, ReferenceFactSchema]);
export type Claim = z.infer<typeof ClaimSchema>;
