import { z } from 'zod';

/** ISO-8601 date or timestamp, e.g. "2026-09-25" or "2026-09-25T10:42:00Z". */
export const IsoStringSchema = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a valid ISO date');
export type IsoString = z.infer<typeof IsoStringSchema>;

export const NamespaceSchema = z.enum(['evidence', 'reference', 'brain', 'org']);
export type Namespace = z.infer<typeof NamespaceSchema>;

export const OriginSchema = z.enum(['evidence', 'reference']);
export type Origin = z.infer<typeof OriginSchema>;

// ---- §6 fact statuses + reason codes
export const FactStatusSchema = z.enum(['VERIFIED', 'LIKELY', 'DISPUTED', 'PROVISIONAL', 'REJECTED', 'UNKNOWN']);
export type FactStatus = z.infer<typeof FactStatusSchema>;

export const REASON_CODES = [
  'SCOPE_MISMATCH',
  'SCOPE_UNDECLARED',
  'SUPERSEDED_TEMPORAL',
  'SUPERSEDED_BY_AUTHORITY',
  'CONTRADICTED_BY_AUTHORITY',
  'CONTRADICTED_BY_CONSENSUS',
  'EXPIRED',
  'INVALIDATED_BY_EVENT',
  'NO_OWNER',
  'OWNER_INACTIVE',
  'EDITED_AFTER_VERIFICATION',
  'VERIFICATION_DECAYED',
  'UNVERIFIED',
  'NEWER_BUT_UNVERIFIED',
  'DERIVED_COPY',
  'NOT_A_RULE',
  'REFERENCE_ONLY',
  'CORROBORATED_INDEPENDENT',
  'AUTHORITATIVE_SOURCE',
  'OWNER_VERIFIED',
  'DUPLICATE_OLDER_VERSION',
] as const;
export const ReasonCodeSchema = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

/** Every status/score carries codes plus a human-readable sentence (CLAUDE invariant 4). */
export const ReasonSchema = z.object({ code: ReasonCodeSchema, message: z.string().min(1).max(500) }).strict();
export type Reason = z.infer<typeof ReasonSchema>;

// ---- §2.1 nodes
export const QuestionTypeSchema = z.enum(['rule', 'procedure', 'amount', 'deadline', 'eligibility', 'other']);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

export const SourceSystemSchema = z.enum(['sharepoint', 'teams', 'email', 'manual', 'ticket', 'other']);
export type SourceSystem = z.infer<typeof SourceSystemSchema>;

export const ProductSchema = z.enum(['pay', 'hr', 'time']);
export type Product = z.infer<typeof ProductSchema>;

/** Verification tiers T0..T4 (SPEC §8.1: weights 0 / 0.3 / 0.6 / 0.85 / 1.0). */
export const TierSchema = z.enum(['T0', 'T1', 'T2', 'T3', 'T4']);
export type Tier = z.infer<typeof TierSchema>;

export const RunStatusSchema = z.enum(['running', 'completed', 'failed']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const Impact = z.enum(['high', 'medium', 'low']);
export type ImpactLevel = z.infer<typeof Impact>;

export const GapTypeSchema = z.enum(['MISSING_SLOT', 'UNRESOLVED_CONFLICT', 'WEAK_SUPPORT', 'MISSING_SCOPE', 'MISSING_TEMPORAL']);
export type GapType = z.infer<typeof GapTypeSchema>;
export const GapStatusSchema = z.enum(['open', 'closed', 'partially_closed']);
export type GapStatus = z.infer<typeof GapStatusSchema>;

/** SPEC leaves Conflict.type open; see docs/brain/DECISIONS.md. */
export const ConflictTypeSchema = z.enum(['value', 'polarity', 'temporal', 'scope', 'textual']);
export type ConflictType = z.infer<typeof ConflictTypeSchema>;
export const SeveritySchema = z.enum(['high', 'medium', 'low']);
export type Severity = z.infer<typeof SeveritySchema>;
export const ConflictStatusSchema = z.enum(['open', 'resolved']);
export type ConflictStatus = z.infer<typeof ConflictStatusSchema>;
export const ResolvedBySchema = z.enum(['rule', 'owner']);
export type ResolvedBy = z.infer<typeof ResolvedBySchema>;

export const VerificationRequestStatusSchema = z.enum(['pending', 'completed', 'expired', 'cancelled']);
export type VerificationRequestStatus = z.infer<typeof VerificationRequestStatusSchema>;
/** §10 actions. */
export const VerificationActionSchema = z.enum(['confirm', 'correct', 'rescope', 'reassign', 'reject']);
export type VerificationAction = z.infer<typeof VerificationActionSchema>;

export const OrgEventTypeSchema = z.enum(['law_change', 'indexation', 'cao_update', 'reorg', 'owner_left']);
export type OrgEventType = z.infer<typeof OrgEventTypeSchema>;

export const SourceKindSchema = z.enum(['evidence', 'reference']);
export type SourceKind = z.infer<typeof SourceKindSchema>;

// ---- claims
export const ValueTypeSchema = z.enum(['number', 'text', 'date', 'bool', 'enum', 'range']);
export type ValueType = z.infer<typeof ValueTypeSchema>;
export const UnitSchema = z.enum(['days', 'hours', 'eur', 'pct', 'weeks', 'months']);
export type Unit = z.infer<typeof UnitSchema>;
export const PolaritySchema = z.enum(['affirms', 'negates']);
export type Polarity = z.infer<typeof PolaritySchema>;
export const ModalitySchema = z.enum(['rule', 'example', 'opinion', 'question', 'unknown']);
export type Modality = z.infer<typeof ModalitySchema>;

// ---- §2.2 edges
export const NODE_KINDS = [
  'case_run',
  'evidence_document',
  'evidence_snapshot',
  'evidence_passage',
  'evidence_claim',
  'wiki_page',
  'wiki_snapshot',
  'wiki_section',
  'reference_fact',
  'fact',
  'gap',
  'conflict',
  'canonical',
  'person',
  'org_event',
  'subject_scope', // composite key `subject|scopeKey` (target of EXPERT_IN / INVALIDATES; not a stored node)
] as const;
export const NodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const EDGE_TYPES = [
  'ASSERTS',
  'MEMBER_OF',
  'AGREES',
  'CONTRADICTS',
  'REFINES',
  'SUPERSEDES',
  'SCOPE_DISJOINT',
  'DUPLICATE_OF',
  'DERIVED_FROM',
  'CORROBORATES',
  'FILLS_GAP',
  'ADDS_CONTEXT',
  'OWNS',
  'VERIFIED',
  'EXPERT_IN',
  'INVALIDATES',
  'RESOLVES',
] as const;
export const EdgeTypeSchema = z.enum(EDGE_TYPES);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

export const MemberRoleSchema = z.enum(['winner', 'support', 'rejected', 'context']);
export type MemberRole = z.infer<typeof MemberRoleSchema>;
export const SupersedeBasisSchema = z.enum(['temporal', 'authority', 'owner']);
export type SupersedeBasis = z.infer<typeof SupersedeBasisSchema>;
