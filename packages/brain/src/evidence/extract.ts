import { createHash } from 'node:crypto';
import {
  EvidenceClaimSchema,
  buildClaimCore,
  evidenceClaimId,
  type EvidenceClaim,
  type EvidenceDocument,
  type EvidencePassage,
  type EvidenceSnapshot,
  type NormalizeHint,
} from '../domain';
import { detectInjection, extractEvidenceTask, runTask, type LLMProvider } from '../llm';

export interface PassageExtraction {
  claims: EvidenceClaim[];
  /** Claims the model returned. */
  raw: number;
  /** Dropped because the quote is not a verbatim substring of the passage. */
  droppedNotVerbatim: number;
  /** Ids of kept claims with no country anywhere (SCOPE_UNDECLARED). */
  scopeUndeclared: string[];
  /** Instruction-like patterns found in the passage (flagged, never obeyed). */
  injection: string[];
}

/**
 * Stage 20 for one passage: LLM extraction → verbatim check → deterministic normalizer → scope fallback → claimKey.
 * The model never sees or sets spans, normalized values, keys, scores or statuses.
 */
export async function extractPassageClaims(args: {
  provider: LLMProvider;
  document: EvidenceDocument;
  snapshot: EvidenceSnapshot;
  passage: EvidencePassage;
  hintFor: (attribute: string) => NormalizeHint | undefined;
  now: string;
}): Promise<PassageExtraction> {
  const { provider, document, snapshot, passage } = args;
  const out = await runTask(provider, extractEvidenceTask({ title: document.title, sourceSystem: document.sourceSystem, declaredScope: document.declaredScope, passage: passage.text }));

  const claims = new Map<string, EvidenceClaim>();
  const scopeUndeclared: string[] = [];
  let droppedNotVerbatim = 0;
  for (const raw of out.claims) {
    const built = buildClaimCore(raw, { text: passage.text, start: passage.start }, document.declaredScope, args.hintFor, args.now);
    if (!built) {
      droppedNotVerbatim++;
      continue;
    }
    const id = evidenceClaimId(`ec-${createHash('sha1').update(`${passage.id}|${raw.quote}|${raw.attribute}|${raw.valueRaw}`).digest('hex').slice(0, 16)}`);
    if (claims.has(id)) continue;
    claims.set(
      id,
      EvidenceClaimSchema.parse({ id, namespace: 'evidence', origin: 'evidence', sourceId: document.id, snapshotId: snapshot.id, passageId: passage.id, ...built.core }),
    );
    if (built.scopeUndeclared) scopeUndeclared.push(id);
  }
  return { claims: [...claims.values()], raw: out.claims.length, droppedNotVerbatim, scopeUndeclared, injection: detectInjection(passage.text) };
}
