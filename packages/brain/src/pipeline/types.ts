import { z } from 'zod';
import { PartialScopeSchema, QueryIntentSchema, RunIdSchema, SlotTemplateSchema } from '../domain';
import { AgentDocumentSchema } from '../evidence';

// zod-typed stage I/O (SPEC §5). Inputs carry only what the caller knows; later stages re-read persisted data by id.

export const IntakeInputSchema = z
  .object({
    question: z.string().trim().min(3).max(1000),
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
});
export type IntakeOutput = z.infer<typeof IntakeOutputSchema>;

export const SnapshotInputSchema = z
  .object({
    runId: RunIdSchema,
    /** The caller's principals (user + groups). Documents that share none of them are dropped before anything is read. */
    principals: z.array(z.string().min(1).max(200)).min(1).max(100),
    documents: z.array(AgentDocumentSchema).min(1).max(50),
  })
  .strict();
export type SnapshotInput = z.infer<typeof SnapshotInputSchema>;

export const SnapshotDocSchema = z.object({
  documentId: z.string(),
  snapshotId: z.string(),
  contentHash: z.string().length(64),
  version: z.number().int().min(1),
  passageIds: z.array(z.string()),
});
export type SnapshotDoc = z.infer<typeof SnapshotDocSchema>;

export const SnapshotOutputSchema = z.object({
  runId: RunIdSchema,
  documents: z.array(SnapshotDocSchema),
  duplicatePairs: z.number().int().min(0),
});
export type SnapshotOutput = z.infer<typeof SnapshotOutputSchema>;

export const ExtractInputSchema = z
  .object({
    runId: RunIdSchema,
    snapshotIds: z.array(z.string().min(1)).max(50),
    slotTemplate: SlotTemplateSchema,
  })
  .strict();
export type ExtractInput = z.infer<typeof ExtractInputSchema>;

export const ExtractOutputSchema = z.object({
  runId: RunIdSchema,
  claimIds: z.array(z.string()),
  claimsByDocument: z.record(z.string(), z.number().int().min(0)),
});
export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;
