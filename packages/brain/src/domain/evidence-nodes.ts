import { LIMITS } from '../security/limits';
import { z } from 'zod';
import { IsoStringSchema, SourceSystemSchema, TierSchema } from './enums';
import { EvidenceDocIdSchema, EvidencePassageIdSchema, EvidenceSnapshotIdSchema, PersonIdSchema, PrincipalIdSchema } from './ids';
import { PartialScopeSchema } from './scope';

const ns = { namespace: z.literal('evidence'), createdAt: IsoStringSchema };

/** The logical case document (SharePoint page, Teams thread, email attachment…). */
export const EvidenceDocumentSchema = z.object({
  id: EvidenceDocIdSchema,
  ...ns,
  sourceSystem: SourceSystemSchema,
  sourceUri: z.string().max(1000),
  title: z.string().min(1).max(300),
  ownerId: PersonIdSchema.optional(),
  authorId: PersonIdSchema.optional(),
  lastEditedAt: IsoStringSchema,
  lastVerifiedAt: IsoStringSchema.optional(),
  verifiedTier: TierSchema.optional(),
  validUntil: IsoStringSchema.optional(),
  declaredScope: PartialScopeSchema,
  allowedPrincipals: z.array(PrincipalIdSchema),
}).strict();
export type EvidenceDocument = z.infer<typeof EvidenceDocumentSchema>;

/** Immutable: exactly what a run read. */
export const EvidenceSnapshotSchema = z.object({
  id: EvidenceSnapshotIdSchema,
  ...ns,
  documentId: EvidenceDocIdSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), // sha256
  text: z.string().max(LIMITS.documentChars),
  fetchedAt: IsoStringSchema,
  version: z.number().int().min(1),
}).strict();
export type EvidenceSnapshot = z.infer<typeof EvidenceSnapshotSchema>;

export const EvidencePassageSchema = z.object({
  id: EvidencePassageIdSchema,
  ...ns,
  snapshotId: EvidenceSnapshotIdSchema,
  ordinal: z.number().int().min(0),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  text: z.string().max(LIMITS.documentChars),
  embedding: z.array(z.number()).optional(),
}).strict();
export type EvidencePassage = z.infer<typeof EvidencePassageSchema>;
