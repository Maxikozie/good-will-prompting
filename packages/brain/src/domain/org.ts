import { z } from 'zod';
import { IsoStringSchema, OrgEventTypeSchema } from './enums';
import { OrgEventIdSchema, PersonIdSchema, PrincipalIdSchema } from './ids';
import { PartialScopeSchema } from './scope';

const ns = { namespace: z.literal('org'), createdAt: IsoStringSchema };

export const PersonSchema = z.object({
  id: PersonIdSchema,
  ...ns,
  name: z.string().min(1).max(200),
  email: z.string().max(200),
  team: z.string().max(200),
  country: z.string().max(100),
  active: z.boolean(),
  principalIds: z.array(PrincipalIdSchema),
}).strict();
export type Person = z.infer<typeof PersonSchema>;

/** Derived (SPEC §11), recomputed on demand; a value object, not a stored node, so it has no id. */
export const ExpertiseSchema = z.object({
  personId: PersonIdSchema,
  subject: z.string().min(1).max(200), // subject or domain
  country: z.string().max(100),
  weight: z.number().min(0).max(1),
}).strict();
export type Expertise = z.infer<typeof ExpertiseSchema>;

export const OrgEventSchema = z.object({
  id: OrgEventIdSchema,
  namespace: z.literal('brain'), // SPEC §2.1 lists OrgEvent under the brain nodes
  createdAt: IsoStringSchema,
  type: OrgEventTypeSchema,
  scope: PartialScopeSchema,
  domain: z.string().max(200),
  effectiveAt: IsoStringSchema,
}).strict();
export type OrgEvent = z.infer<typeof OrgEventSchema>;
