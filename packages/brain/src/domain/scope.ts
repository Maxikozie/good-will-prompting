import { z } from 'zod';
import { ProductSchema } from './enums';

/** SPEC §2.1 Scope. `country: null` = undeclared (→ SCOPE_UNDECLARED). Belgian payroll aware: PC + employee category. */
export const ScopeSchema = z.object({
  country: z.string().trim().min(2).max(100).nullable(),
  region: z.string().trim().max(100).optional(),
  jointCommittee: z.string().trim().max(50).optional(), // paritair comité, e.g. "PC 200"
  employeeCategory: z.string().trim().max(50).optional(), // bediende | arbeider | …
  product: ProductSchema.optional(),
  customerId: z.string().trim().max(100).optional(),
  language: z.string().trim().max(20).optional(),
}).strict();
export type Scope = z.infer<typeof ScopeSchema>;

export const PartialScopeSchema = ScopeSchema.partial();
export type PartialScope = z.infer<typeof PartialScopeSchema>;
