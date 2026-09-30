import type { Claim } from './claim';
import type { Modality, Polarity } from './enums';
import { claimKey, mergeScope } from './keys';
import { normalizeValue, type NormalizeHint } from './normalize';
import type { PartialScope } from './scope';
import type { Qualifiers } from './claim';

/** What an extractor (LLM, reference prompt variant, …) hands over. No spans, no normalized value, no key: code adds those. */
export interface RawClaim {
  quote: string;
  subject: string;
  attribute: string;
  valueRaw: string;
  qualifiers: PartialScope & { conditions: string[] };
  temporal: { effectiveFrom?: string; effectiveTo?: string; statedAsOf?: string };
  polarity: Polarity;
  modality: Modality;
  confidence: number;
}

/** The passage/section the claim was extracted from, placed inside its snapshot text. */
export interface SourceText {
  text: string;
  /** Offset of `text` inside the snapshot text. */
  start: number;
}

export type ClaimCore = Pick<Claim, 'span' | 'quote' | 'subject' | 'attribute' | 'value' | 'qualifiers' | 'temporal' | 'polarity' | 'modality' | 'extractionConfidence' | 'claimKey' | 'createdAt'>;

export interface BuiltClaim {
  core: ClaimCore;
  /** Neither the claim nor the document stated a country → `qualifiers.country === null` (reason SCOPE_UNDECLARED, gap MISSING_SCOPE). */
  scopeUndeclared: boolean;
}

/** Offset of `quote` inside `text` if it occurs there character for character, else -1. No fuzzy matching, by design. */
export function verbatimOffset(text: string, quote: string): number {
  return quote.length === 0 ? -1 : text.indexOf(quote);
}

/**
 * Turn a raw extracted claim into the stored shape (SPEC §3 / §5 stage 20):
 *  - null if the quote is not a verbatim substring of the passage (anti-hallucination, the caller counts the drop)
 *  - span = exact character offsets in the snapshot
 *  - value normalized by deterministic code, never by the LLM
 *  - qualifiers = what the claim states, falling back to the document's declaredScope; country null if nobody declared one
 *  - claimKey = sha1(subject|attribute|scopeKey)
 */
export function buildClaimCore(raw: RawClaim, source: SourceText, declaredScope: PartialScope, hintFor: (attribute: string) => NormalizeHint | undefined, createdAt: string): BuiltClaim | null {
  const at = verbatimOffset(source.text, raw.quote);
  if (at < 0) return null;

  const merged = mergeScope(declaredScope, raw.qualifiers);
  const scopeUndeclared = merged.country === undefined || merged.country === null;
  const qualifiers: Qualifiers = { ...merged, country: scopeUndeclared ? null : merged.country, conditions: raw.qualifiers.conditions };

  const value = normalizeValue(raw.valueRaw, hintFor(raw.attribute));
  const temporal = { ...raw.temporal };
  if (!temporal.effectiveFrom && raw.attribute === 'effective_from' && value.type === 'date') temporal.effectiveFrom = value.normalized as string;

  const start = source.start + at;
  return {
    scopeUndeclared,
    core: {
      span: { start, end: start + raw.quote.length },
      quote: raw.quote,
      subject: raw.subject,
      attribute: raw.attribute,
      value,
      qualifiers,
      temporal,
      polarity: raw.polarity,
      modality: raw.modality,
      extractionConfidence: raw.confidence,
      claimKey: claimKey({ subject: raw.subject, attribute: raw.attribute, qualifiers, declaredScope }),
      createdAt,
    },
  };
}
