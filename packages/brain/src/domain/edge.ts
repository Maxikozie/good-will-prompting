import { z } from 'zod';
import { SpanSchema } from './claim';
import {
  ConflictTypeSchema,
  EDGE_TYPES,
  IsoStringSchema,
  MemberRoleSchema,
  ReasonCodeSchema,
  SeveritySchema,
  SupersedeBasisSchema,
  TierSchema,
  type NodeKind,
} from './enums';
import { EdgeIdSchema, NodeIdSchema, RunIdSchema } from './ids';

// SPEC §2.2. One schema per edge type, with typed props and the node kinds it may connect.
function edge<T extends string, F extends NodeKind, K extends NodeKind, P extends z.ZodType>(
  type: T,
  from: readonly [F, ...F[]],
  to: readonly [K, ...K[]],
  props: P,
) {
  return z.object({
    id: EdgeIdSchema,
    type: z.literal(type),
    fromId: NodeIdSchema,
    fromKind: z.enum(from),
    toId: NodeIdSchema,
    toKind: z.enum(to),
    props,
    runId: RunIdSchema.optional(),
  });
}

const CLAIM_KINDS = ['evidence_claim', 'reference_fact'] as const satisfies readonly NodeKind[];
const SNAPSHOT_KINDS = ['evidence_snapshot', 'wiki_snapshot'] as const satisfies readonly NodeKind[];
const score = z.object({ score: z.number().min(0).max(1) });
// Relation edges may carry how they were decided (code or LLM) and a one-sentence explanation (mandatory for LLM decisions on text).
const how = { method: z.enum(['rule', 'llm']).optional(), explanation: z.string().min(1).max(500).optional() };
const methodScore = z.object({ method: z.enum(['simhash', 'cosine', 'link', 'exact']), score: z.number().min(0).max(1) });

export const AssertsEdgeSchema = edge('ASSERTS', SNAPSHOT_KINDS, CLAIM_KINDS, z.object({ span: SpanSchema }));
export const MemberOfEdgeSchema = edge('MEMBER_OF', CLAIM_KINDS, ['fact'], z.object({ role: MemberRoleSchema, reason: ReasonCodeSchema.optional() }));
export const AgreesEdgeSchema = edge('AGREES', CLAIM_KINDS, CLAIM_KINDS, z.object({ similarity: z.number().min(0).max(1), ...how }));
export const ContradictsEdgeSchema = edge(
  'CONTRADICTS',
  CLAIM_KINDS,
  CLAIM_KINDS,
  z.object({ type: ConflictTypeSchema, severity: SeveritySchema, explanation: z.string().min(1).max(500), method: how.method }),
);
export const RefinesEdgeSchema = edge('REFINES', CLAIM_KINDS, CLAIM_KINDS, z.object({ addedQualifiers: z.array(z.string().max(100)), ...how }));
export const SupersedesEdgeSchema = edge('SUPERSEDES', CLAIM_KINDS, CLAIM_KINDS, z.object({ basis: SupersedeBasisSchema, ...how }));
export const ScopeDisjointEdgeSchema = edge('SCOPE_DISJOINT', CLAIM_KINDS, CLAIM_KINDS, z.object({ differingScopeKeys: z.array(z.string().max(50)).min(1), ...how }));
export const DuplicateOfEdgeSchema = edge('DUPLICATE_OF', ['evidence_passage'], ['evidence_passage'], methodScore);
export const DerivedFromEdgeSchema = edge(
  'DERIVED_FROM',
  ['evidence_snapshot', 'wiki_snapshot', 'wiki_section'],
  ['evidence_snapshot', 'wiki_snapshot', 'wiki_section'],
  methodScore,
);
export const CorroboratesEdgeSchema = edge('CORROBORATES', ['reference_fact'], ['fact'], score);
export const FillsGapEdgeSchema = edge('FILLS_GAP', ['reference_fact'], ['gap'], score);
export const AddsContextEdgeSchema = edge('ADDS_CONTEXT', ['reference_fact'], ['fact', 'gap'], score);
export const OwnsEdgeSchema = edge('OWNS', ['person'], ['evidence_document', 'wiki_page', 'evidence_claim', 'reference_fact'], z.object({ since: IsoStringSchema }));
export const VerifiedEdgeSchema = edge(
  'VERIFIED',
  ['person'],
  ['evidence_claim', 'reference_fact', 'fact'],
  z.object({ tier: TierSchema, at: IsoStringSchema, expiresAt: IsoStringSchema.optional() }),
);
export const ExpertInEdgeSchema = edge('EXPERT_IN', ['person'], ['subject_scope'], z.object({ weight: z.number().min(0).max(1) }));
export const InvalidatesEdgeSchema = edge('INVALIDATES', ['org_event'], ['subject_scope'], z.object({ effectiveAt: IsoStringSchema }));
export const ResolvesEdgeSchema = edge('RESOLVES', ['canonical'], ['fact'], z.object({}));

/** Discriminated union on `type`. */
export const EdgeSchema = z.discriminatedUnion('type', [
  AssertsEdgeSchema,
  MemberOfEdgeSchema,
  AgreesEdgeSchema,
  ContradictsEdgeSchema,
  RefinesEdgeSchema,
  SupersedesEdgeSchema,
  ScopeDisjointEdgeSchema,
  DuplicateOfEdgeSchema,
  DerivedFromEdgeSchema,
  CorroboratesEdgeSchema,
  FillsGapEdgeSchema,
  AddsContextEdgeSchema,
  OwnsEdgeSchema,
  VerifiedEdgeSchema,
  ExpertInEdgeSchema,
  InvalidatesEdgeSchema,
  ResolvesEdgeSchema,
]);
export type Edge = z.infer<typeof EdgeSchema>;
export type EdgeOfType<T extends Edge['type']> = Extract<Edge, { type: T }>;

// Keep the union and the EDGE_TYPES enum in lockstep (checked at import time, cheap).
const unionTypes = new Set(EdgeSchema.options.map((o) => o.shape.type.value));
for (const t of EDGE_TYPES) if (!unionTypes.has(t)) throw new Error(`EdgeSchema is missing type ${t}`);
