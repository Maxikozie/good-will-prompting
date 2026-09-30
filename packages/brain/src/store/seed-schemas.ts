import { z } from 'zod';
import { IsoStringSchema, PartialScopeSchema, SourceSystemSchema, TierSchema } from '../domain';
const id = z.string().min(1).max(200);
const common = {
  id, title: z.string().min(1).max(300), uri: z.string().min(1).max(1000), owner: id.nullish(), last_edited: IsoStringSchema,
  last_verified: IsoStringSchema.nullish(), declared_scope: PartialScopeSchema.default({}), allowed_principals: z.array(id).max(100).default([]),
};
export const EvidenceSeedSchema = z.object({ ...common, source_system: SourceSystemSchema, author: id.optional(), verified_tier: TierSchema.optional(), valid_until: IsoStringSchema.nullish() }).strict();
export const ReferenceSeedSchema = z.object({ ...common, space: z.string().max(100), official: z.boolean().default(false), out_links: z.array(id).max(100).default([]) }).strict();
export const OrgSeedSchema = z.object({ created_at: IsoStringSchema.optional(),
  people: z.array(z.object({ id, name: id, email: id, team: id, country: id, active: z.boolean(), principal_ids: z.array(id).max(100).default([]) }).strict()).max(1000),
  expertise: z.array(z.object({ person: id, subject: id, country: id, weight: z.number().min(0).max(1) }).strict()).max(1000),
}).strict();
