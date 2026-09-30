import { boundText } from '../security/input';
import { LIMITS } from '../security/limits';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  EvidenceDocumentSchema,
  PartialScopeSchema,
  IsoStringSchema,
  SourceSystemSchema,
  TierSchema,
  evidenceDocId,
  personId,
  principalId,
  type EvidenceDocument,
} from '../domain';
import type { Db } from '../store/db';
import * as repo from '../store/evidence-repo';

// INTEGRATION.md §3: maps the agent's document payload (brain_analyze_case `documents`, SPEC §12) onto EvidenceDocument + text.

export const DocMetadataSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    sourceSystem: SourceSystemSchema.optional(),
    owner: z.string().min(1).max(200).optional(),
    author: z.string().min(1).max(200).optional(),
    lastEditedAt: IsoStringSchema.optional(),
    lastVerifiedAt: IsoStringSchema.optional(),
    verifiedTier: TierSchema.optional(),
    validUntil: IsoStringSchema.optional(),
    declaredScope: PartialScopeSchema.optional(),
    allowedPrincipals: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict();

/** Payload of one document the agent returned: an id/uri of a known document and/or its text plus metadata. */
export const AgentDocumentSchema = z
  .object({
    id: z.string().trim().min(1).max(200).optional(),
    uri: z.string().trim().min(1).max(1000).optional(),
    text: z.string().max(LIMITS.documentChars).optional(),
    metadata: DocMetadataSchema.optional(),
  })
  .strict()
  .refine((d) => d.id || d.uri || d.text, { message: 'a document needs an id, a uri or text' });
export type AgentDocument = z.infer<typeof AgentDocumentSchema>;

export interface ResolvedDocument {
  document: EvidenceDocument;
  /** The text this run reads: the payload's text, else the latest stored snapshot. */
  text: string;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const iso = (v: string) => new Date(v).toISOString();

/** Apply payload metadata on top of a stored document (payload wins). */
function overlay(base: EvidenceDocument, m: NonNullable<AgentDocument['metadata']>): EvidenceDocument {
  return EvidenceDocumentSchema.parse({
    ...base,
    ...(m.title ? { title: m.title } : {}),
    ...(m.sourceSystem ? { sourceSystem: m.sourceSystem } : {}),
    ...(m.owner ? { ownerId: personId(m.owner) } : {}),
    ...(m.author ? { authorId: personId(m.author) } : {}),
    ...(m.lastEditedAt ? { lastEditedAt: iso(m.lastEditedAt) } : {}),
    ...(m.lastVerifiedAt ? { lastVerifiedAt: iso(m.lastVerifiedAt) } : {}),
    ...(m.verifiedTier ? { verifiedTier: m.verifiedTier } : {}),
    ...(m.validUntil ? { validUntil: iso(m.validUntil) } : {}),
    ...(m.declaredScope ? { declaredScope: { ...base.declaredScope, ...m.declaredScope } } : {}),
    ...(m.allowedPrincipals ? { allowedPrincipals: m.allowedPrincipals.map(principalId) } : {}),
  });
}

/**
 * Resolve one payload: a known document (by id, else by uri) keeps its stored metadata/ACL; an unknown one is created from
 * the payload with conservative defaults (readable by the caller only). Returns null if there is nothing to read.
 */
export async function resolveDocument(db: Db, payload: AgentDocument, ctx: { callerPrincipal: string; now: string }): Promise<ResolvedDocument | null> {
  payload = AgentDocumentSchema.parse(payload);
  const known = (payload.id ? await repo.getDocument(db, payload.id) : null) ?? (payload.uri ? await repo.getDocumentByUri(db, payload.uri) : null);
  if (known) {
    const document = payload.metadata ? overlay(known, payload.metadata) : known;
    const text = payload.text ?? (await repo.latestSnapshot(db, known.id))?.text;
    return text === undefined ? null : { document, text: boundText(text) };
  }
  if (payload.text === undefined) return null;
  const m = payload.metadata ?? {};
  const id = payload.id ?? `ext-${sha1(`${payload.uri ?? ''}|${m.title ?? ''}|${payload.text}`).slice(0, 12)}`;
  const document = EvidenceDocumentSchema.parse({
    id: evidenceDocId(id),
    namespace: 'evidence',
    createdAt: ctx.now,
    sourceSystem: m.sourceSystem ?? 'other',
    sourceUri: payload.uri ?? `urn:brain:payload:${id}`,
    title: m.title ?? payload.uri ?? id,
    ...(m.owner ? { ownerId: personId(m.owner) } : {}),
    ...(m.author ? { authorId: personId(m.author) } : {}),
    lastEditedAt: m.lastEditedAt ? iso(m.lastEditedAt) : ctx.now, // unknown edit date: treat as "now" (never as verified)
    ...(m.lastVerifiedAt ? { lastVerifiedAt: iso(m.lastVerifiedAt) } : {}),
    ...(m.verifiedTier ? { verifiedTier: m.verifiedTier } : {}),
    ...(m.validUntil ? { validUntil: iso(m.validUntil) } : {}),
    declaredScope: m.declaredScope ?? {},
    allowedPrincipals: (m.allowedPrincipals ?? [ctx.callerPrincipal]).map(principalId), // MOCK default: only the caller may read it
  });
  return { document, text: payload.text };
}
