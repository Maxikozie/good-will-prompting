import { EvidenceClaimSchema, ReferenceFactSchema, type EvidenceClaim, type ReferenceFact } from '../domain';
import { isoReq, json, parseRow } from './rows';

// evidence.claim and reference.reference_fact share the same columns (SPEC §3).
type ClaimLike = EvidenceClaim | ReferenceFact;

export function claimCols(c: ClaimLike) {
  return {
    id: c.id,
    source_id: c.sourceId,
    snapshot_id: c.snapshotId,
    passage_id: c.passageId,
    span_start: c.span.start,
    span_end: c.span.end,
    quote: c.quote,
    subject: c.subject,
    attribute: c.attribute,
    value: json(c.value),
    qualifiers: json(c.qualifiers),
    temporal: json(c.temporal),
    polarity: c.polarity,
    modality: c.modality,
    extraction_confidence: c.extractionConfidence,
    claim_key: c.claimKey,
    created_at: c.createdAt,
  };
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- raw DB row, parsed by zod below

function common(r: Row) {
  return {
    id: r.id,
    sourceId: r.source_id,
    snapshotId: r.snapshot_id,
    passageId: r.passage_id,
    span: { start: r.span_start, end: r.span_end },
    quote: r.quote,
    subject: r.subject,
    attribute: r.attribute,
    value: r.value,
    qualifiers: r.qualifiers,
    temporal: r.temporal,
    polarity: r.polarity,
    modality: r.modality,
    extractionConfidence: r.extraction_confidence,
    claimKey: r.claim_key,
    createdAt: isoReq(r.created_at),
  };
}

export const evidenceClaimFromRow = (r: Row): EvidenceClaim => parseRow(EvidenceClaimSchema, { ...common(r), namespace: 'evidence', origin: 'evidence' });
export const referenceFactFromRow = (r: Row): ReferenceFact => parseRow(ReferenceFactSchema, { ...common(r), namespace: 'reference', origin: 'reference' });
