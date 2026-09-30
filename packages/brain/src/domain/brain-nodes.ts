import { z } from 'zod';
import { ClaimValueSchema } from './claim';
import {
  ConflictStatusSchema,
  ConflictTypeSchema,
  FactStatusSchema,
  GapStatusSchema,
  GapTypeSchema,
  Impact,
  IsoStringSchema,
  QuestionTypeSchema,
  ReasonCodeSchema,
  ReasonSchema,
  ResolvedBySchema,
  RunStatusSchema,
  SeveritySchema,
  SourceKindSchema,
  TierSchema,
  VerificationActionSchema,
  VerificationRequestStatusSchema,
} from './enums';
import {
  ClaimIdSchema,
  ConflictIdSchema,
  EvidenceSnapshotIdSchema,
  FactIdSchema,
  GapIdSchema,
  PersonIdSchema,
  PrincipalIdSchema,
  ReferenceFactIdSchema,
  RunIdSchema,
  SourceIdSchema,
  VerificationEventIdSchema,
  VerificationRequestIdSchema,
  WikiSnapshotIdSchema,
} from './ids';
import { ScopeSchema } from './scope';

const ns = { namespace: z.literal('brain'), createdAt: IsoStringSchema };

// ---- run & query
export const QueryIntentSchema = z.object({
  subject: z.string().min(1).max(200),
  scope: ScopeSchema,
  questionType: QuestionTypeSchema,
  slotTemplateId: z.string().max(200),
  generatedSlots: z.boolean(),
});
export type QueryIntent = z.infer<typeof QueryIntentSchema>;

export const CaseRunSchema = z.object({
  id: RunIdSchema,
  ...ns,
  question: z.string().min(1).max(1000),
  principalId: PrincipalIdSchema,
  intent: QueryIntentSchema,
  status: RunStatusSchema,
  rulesVersion: z.string().max(100),
  promptVersions: z.record(z.string(), z.string()),
  modelIds: z.record(z.string(), z.string()),
  evidenceSnapshotIds: z.array(EvidenceSnapshotIdSchema),
  referenceSnapshotIds: z.array(WikiSnapshotIdSchema),
  startedAt: IsoStringSchema,
  finishedAt: IsoStringSchema.optional(),
});
export type CaseRun = z.infer<typeof CaseRunSchema>;

// ---- facts, gaps, conflicts
/** Statuses a fact supported only by the reference corpus (wiki) can never exceed: it needs evidence or an owner to go higher (SPEC §1). */
export const REFERENCE_ONLY_FORBIDDEN_STATUSES = ['VERIFIED', 'LIKELY'] as const;

/**
 * An aligned proposition: all claims about the same subject+attribute+scope.
 * `referenceOnly` = every member is a reference fact. It is part of the type, and the schema refuses
 * a referenceOnly fact with status VERIFIED or LIKELY (so the ceiling holds for anything parsed, stored or loaded).
 */
export const FactSchema = z
  .object({
    id: FactIdSchema,
    ...ns,
    runId: RunIdSchema,
    claimKey: z.string().regex(/^[a-f0-9]{40}$/),
    subject: z.string().min(1).max(200),
    attribute: z.string().min(1).max(100),
    scope: ScopeSchema,
    slotId: z.string().max(100).optional(),
    status: FactStatusSchema,
    confidence: z.number().min(0).max(100),
    winnerClaimId: ClaimIdSchema.optional(),
    winningValue: ClaimValueSchema.optional(),
    reasons: z.array(ReasonSchema),
    needsVerification: z.boolean(),
    impact: Impact,
    referenceOnly: z.boolean().default(false),
  })
  .refine((f) => !(f.referenceOnly && (REFERENCE_ONLY_FORBIDDEN_STATUSES as readonly string[]).includes(f.status)), {
    message: 'a fact supported only by reference facts cannot be VERIFIED or LIKELY (max PROVISIONAL)',
    path: ['status'],
  });
export type Fact = z.infer<typeof FactSchema>;

export const GapSchema = z.object({
  id: GapIdSchema,
  ...ns,
  runId: RunIdSchema,
  type: GapTypeSchema,
  slotId: z.string().max(100).optional(),
  factId: FactIdSchema.optional(),
  description: z.string().max(500),
  closedBy: z.array(ReferenceFactIdSchema).optional(),
  status: GapStatusSchema,
});
export type Gap = z.infer<typeof GapSchema>;

export const ConflictSchema = z.object({
  id: ConflictIdSchema,
  ...ns,
  runId: RunIdSchema,
  factId: FactIdSchema,
  type: ConflictTypeSchema,
  severity: SeveritySchema,
  claimIds: z.array(ClaimIdSchema).min(2),
  resolution: z.string().max(500).optional(), // ladder rule id (e.g. "5_newer_but_unverified") or the owner's action
  resolvedBy: ResolvedBySchema.optional(),
  status: ConflictStatusSchema,
});
export type Conflict = z.infer<typeof ConflictSchema>;

export const CanonicalSchema = z.object({
  key: z.string().min(1).max(500), // subject|attribute|scopeKey
  ...ns,
  value: ClaimValueSchema,
  factId: FactIdSchema,
  runId: RunIdSchema,
  confidence: z.number().min(0).max(100),
  verifiedTier: TierSchema,
  nextReviewAt: IsoStringSchema,
});
export type Canonical = z.infer<typeof CanonicalSchema>;

/** Stored per run and source (SPEC §9). Rejected claims never earn contribution. */
export const AttributionSchema = z.object({
  runId: RunIdSchema,
  sourceKind: SourceKindSchema,
  sourceId: SourceIdSchema,
  contributionPct: z.number().min(0).max(100),
  acceptedClaims: z.array(ClaimIdSchema),
  rejectedClaims: z.array(z.object({ claimId: ClaimIdSchema, code: ReasonCodeSchema })),
  reliabilityPct: z.number().min(0).max(100),
});
export type Attribution = z.infer<typeof AttributionSchema>;

// ---- verification (§10)
export const VerificationRequestSchema = z.object({
  id: VerificationRequestIdSchema,
  ...ns,
  factId: FactIdSchema,
  requestedFromId: PersonIdSchema,
  reason: z.string().max(500),
  status: VerificationRequestStatusSchema,
  tokenJti: z.string().min(8).max(100),
  expiresAt: IsoStringSchema,
});
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

/** Append-only audit record. */
export const VerificationEventSchema = z.object({
  id: VerificationEventIdSchema,
  ...ns,
  factId: FactIdSchema,
  claimId: ClaimIdSchema.optional(),
  verifierId: PersonIdSchema,
  action: VerificationActionSchema,
  tier: TierSchema,
  payload: z.record(z.string(), z.unknown()),
  at: IsoStringSchema,
});
export type VerificationEvent = z.infer<typeof VerificationEventSchema>;
