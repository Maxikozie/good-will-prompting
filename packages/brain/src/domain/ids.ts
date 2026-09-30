import { z } from 'zod';

// Branded ids: evidence and reference ids are distinct types, so mixing them is a compile error (SPEC §1).
const id = <B extends string>() => z.string().min(1).max(200).brand<B>();

export const EvidenceDocIdSchema = id<'EvidenceDocId'>();
export const EvidenceSnapshotIdSchema = id<'EvidenceSnapshotId'>();
export const EvidencePassageIdSchema = id<'EvidencePassageId'>();
export const EvidenceClaimIdSchema = id<'EvidenceClaimId'>();

export const WikiPageIdSchema = id<'WikiPageId'>();
export const WikiSnapshotIdSchema = id<'WikiSnapshotId'>();
export const WikiSectionIdSchema = id<'WikiSectionId'>();
export const ReferenceFactIdSchema = id<'ReferenceFactId'>();

export const RunIdSchema = id<'RunId'>();
export const FactIdSchema = id<'FactId'>();
export const GapIdSchema = id<'GapId'>();
export const ConflictIdSchema = id<'ConflictId'>();
export const PersonIdSchema = id<'PersonId'>();
export const VerificationRequestIdSchema = id<'VerificationRequestId'>();
export const VerificationEventIdSchema = id<'VerificationEventId'>();
export const OrgEventIdSchema = id<'OrgEventId'>();
export const EdgeIdSchema = id<'EdgeId'>();

/** Untyped node id, used only on edges that span kinds (the edge's fromKind/toKind say what it points at). */
export const NodeIdSchema = z.string().min(1).max(200);

export type EvidenceDocId = z.infer<typeof EvidenceDocIdSchema>;
export type EvidenceSnapshotId = z.infer<typeof EvidenceSnapshotIdSchema>;
export type EvidencePassageId = z.infer<typeof EvidencePassageIdSchema>;
export type EvidenceClaimId = z.infer<typeof EvidenceClaimIdSchema>;
export type WikiPageId = z.infer<typeof WikiPageIdSchema>;
export type WikiSnapshotId = z.infer<typeof WikiSnapshotIdSchema>;
export type WikiSectionId = z.infer<typeof WikiSectionIdSchema>;
export type ReferenceFactId = z.infer<typeof ReferenceFactIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type FactId = z.infer<typeof FactIdSchema>;
export type GapId = z.infer<typeof GapIdSchema>;
export type ConflictId = z.infer<typeof ConflictIdSchema>;
export type PersonId = z.infer<typeof PersonIdSchema>;
export type VerificationRequestId = z.infer<typeof VerificationRequestIdSchema>;
export type VerificationEventId = z.infer<typeof VerificationEventIdSchema>;
export type OrgEventId = z.infer<typeof OrgEventIdSchema>;
export type EdgeId = z.infer<typeof EdgeIdSchema>;
export type NodeId = z.infer<typeof NodeIdSchema>;

/** Claim-bearing source id: EvidenceDocId or WikiPageId (discriminated by Claim.origin). */
export type SourceId = EvidenceDocId | WikiPageId;

// Cast helpers for tests, seeds and adapters (they do no validation: parse with the schema at real boundaries).
export const evidenceDocId = (s: string) => s as EvidenceDocId;
export const evidenceSnapshotId = (s: string) => s as EvidenceSnapshotId;
export const evidencePassageId = (s: string) => s as EvidencePassageId;
export const evidenceClaimId = (s: string) => s as EvidenceClaimId;
export const wikiPageId = (s: string) => s as WikiPageId;
export const wikiSnapshotId = (s: string) => s as WikiSnapshotId;
export const wikiSectionId = (s: string) => s as WikiSectionId;
export const referenceFactId = (s: string) => s as ReferenceFactId;
export const runId = (s: string) => s as RunId;
export const factId = (s: string) => s as FactId;
export const personId = (s: string) => s as PersonId;

/** Who is asking / allowed to read. "*" = everyone (MOCK ACL, see docs/brain/INTEGRATION.md §6 #10). */
export const PrincipalIdSchema = id<'PrincipalId'>();
export type PrincipalId = z.infer<typeof PrincipalIdSchema>;
export const principalId = (s: string) => s as PrincipalId;

/** Either kind of claim id (a winner/member can be evidence or reference). */
export const ClaimIdSchema = z.union([EvidenceClaimIdSchema, ReferenceFactIdSchema]);
export type ClaimId = z.infer<typeof ClaimIdSchema>;
export const SourceIdSchema = z.union([EvidenceDocIdSchema, WikiPageIdSchema]);
