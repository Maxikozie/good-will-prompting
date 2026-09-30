import { LIMITS } from '../security/limits';
import { z } from 'zod';
import { PartialScopeSchema, QueryIntentSchema, RunIdSchema, SlotTemplateSchema } from '../domain';
import { AgentDocumentSchema } from '../evidence';

// zod-typed stage I/O (SPEC §5). Inputs carry only what the caller knows; later stages re-read persisted data by id.

export const IntakeInputSchema = z
  .object({
    question: z.string().trim().min(3).max(LIMITS.questionChars),
    /** Who asks (an id such as "user:nina.maes"). Stored on the CaseRun and used for the ACL filter. */
    principalId: z.string().trim().min(1).max(200),
    /** Scope the caller already knows (e.g. from the employee's profile): wins over what the model reads from the question. */
    scopeHint: PartialScopeSchema.optional(),
    /** Normally derived; pass one to make the run id predictable. */
    runId: RunIdSchema.optional(),
  })
  .strict();
export type IntakeInput = z.infer<typeof IntakeInputSchema>;

export const IntakeOutputSchema = z.object({
  runId: RunIdSchema,
  intent: QueryIntentSchema,
  slotTemplate: SlotTemplateSchema,
}).strict();
export type IntakeOutput = z.infer<typeof IntakeOutputSchema>;

export const SnapshotInputSchema = z
  .object({
    runId: RunIdSchema,
    /** The caller's principals (user + groups). Documents that share none of them are dropped before anything is read. */
    principals: z.array(z.string().min(1).max(200)).min(1).max(100),
    documents: z.array(AgentDocumentSchema).min(1).max(LIMITS.documentsPerCase),
  })
  .strict();
export type SnapshotInput = z.infer<typeof SnapshotInputSchema>;

export const SnapshotDocSchema = z.object({
  documentId: z.string(),
  snapshotId: z.string(),
  contentHash: z.string().length(64),
  version: z.number().int().min(1),
  passageIds: z.array(z.string()),
}).strict();
export type SnapshotDoc = z.infer<typeof SnapshotDocSchema>;

export const SnapshotOutputSchema = z.object({
  runId: RunIdSchema,
  documents: z.array(SnapshotDocSchema),
  duplicatePairs: z.number().int().min(0),
}).strict();
export type SnapshotOutput = z.infer<typeof SnapshotOutputSchema>;

export const ExtractInputSchema = z
  .object({
    runId: RunIdSchema,
    snapshotIds: z.array(z.string().min(1)).max(LIMITS.documentsPerCase),
    slotTemplate: SlotTemplateSchema,
  })
  .strict();
export type ExtractInput = z.infer<typeof ExtractInputSchema>;

export const ExtractOutputSchema = z.object({
  runId: RunIdSchema,
  claimIds: z.array(z.string()),
  claimsByDocument: z.record(z.string(), z.number().int().min(0)),
}).strict();
export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;

export const AlignInputSchema = z.object({ runId: RunIdSchema, slotTemplate: SlotTemplateSchema }).strict();
export type AlignInput = z.infer<typeof AlignInputSchema>;

export const AlignOutputSchema = z.object({
  runId: RunIdSchema,
  factIds: z.array(z.string()),
  /** Facts that answer the query scope (status is decided in stage 60). */
  inScopeFactIds: z.array(z.string()),
  /** Claims outside the query scope: kept in the graph, rejected with SCOPE_MISMATCH. */
  scopeMismatchClaimIds: z.array(z.string()),
  relations: z.record(z.string(), z.number().int().min(0)),
}).strict();
export type AlignOutput = z.infer<typeof AlignOutputSchema>;

export const GapsInputSchema = z.object({ runId: RunIdSchema, slotTemplate: SlotTemplateSchema }).strict();
export type GapsInput = z.infer<typeof GapsInputSchema>;

export const GapsOutputSchema = z.object({
  runId: RunIdSchema,
  gapIds: z.array(z.string()),
  gapsByType: z.record(z.string(), z.number().int().min(0)),
}).strict();
export type GapsOutput = z.infer<typeof GapsOutputSchema>;

export const EnrichInputSchema = z
  .object({
    runId: RunIdSchema,
    slotTemplate: SlotTemplateSchema,
    /** The caller's principals: wiki pages they may not read are never searched. */
    principals: z.array(z.string().min(1).max(200)).min(1).max(100),
  })
  .strict();
export type EnrichInput = z.infer<typeof EnrichInputSchema>;

export const EnrichOutputSchema = z.object({
  runId: RunIdSchema,
  referenceFactIds: z.array(z.string()),
  closedGapIds: z.array(z.string()),
  partiallyClosedGapIds: z.array(z.string()),
  /** Bridge edges written, by type. */
  bridges: z.record(z.string(), z.number().int().min(0)),
  queriesIssued: z.number().int().min(0),
}).strict();
export type EnrichOutput = z.infer<typeof EnrichOutputSchema>;
