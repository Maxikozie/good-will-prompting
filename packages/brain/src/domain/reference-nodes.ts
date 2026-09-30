import { LIMITS } from '../security/limits';
import { z } from 'zod';
import { IsoStringSchema } from './enums';
import { PersonIdSchema, PrincipalIdSchema, WikiPageIdSchema, WikiSectionIdSchema, WikiSnapshotIdSchema } from './ids';
import { PartialScopeSchema } from './scope';

const ns = { namespace: z.literal('reference'), createdAt: IsoStringSchema };

/** Wiki page (reference corpus). Not the same thing as the repo's core `WikiPage` (TrustLayer vault page). */
export const WikiPageSchema = z.object({
  id: WikiPageIdSchema,
  ...ns,
  space: z.string().max(100),
  title: z.string().min(1).max(300),
  uri: z.string().max(1000),
  ownerId: PersonIdSchema.optional(),
  official: z.boolean(),
  lastEditedAt: IsoStringSchema,
  lastVerifiedAt: IsoStringSchema.optional(),
  declaredScope: PartialScopeSchema,
  allowedPrincipals: z.array(PrincipalIdSchema),
  outLinks: z.array(WikiPageIdSchema),
}).strict();
export type WikiPage = z.infer<typeof WikiPageSchema>;

export const WikiSnapshotSchema = z.object({
  id: WikiSnapshotIdSchema,
  ...ns,
  pageId: WikiPageIdSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().max(LIMITS.documentChars),
  fetchedAt: IsoStringSchema,
}).strict();
export type WikiSnapshot = z.infer<typeof WikiSnapshotSchema>;

export const WikiSectionSchema = z.object({
  id: WikiSectionIdSchema,
  ...ns,
  snapshotId: WikiSnapshotIdSchema,
  headingPath: z.array(z.string().max(300)),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  text: z.string().max(LIMITS.documentChars),
  embedding: z.array(z.number()).optional(),
}).strict();
export type WikiSection = z.infer<typeof WikiSectionSchema>;
