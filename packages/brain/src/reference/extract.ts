import { createHash } from 'node:crypto';
import {
  ReferenceFactSchema,
  buildClaimCore,
  referenceFactId,
  type NormalizeHint,
  type ReferenceFact,
  type WikiPage,
  type WikiSection,
  type WikiSnapshot,
} from '../domain';
import { detectInjection, extractReferenceTask, runTask, type LLMProvider } from '../llm';

export interface SectionExtraction {
  facts: ReferenceFact[];
  raw: number;
  droppedNotVerbatim: number;
  scopeUndeclared: string[];
  injection: string[];
}

/** Reference variant of stage 20: same verbatim check, normalizer, scope fallback and claimKey, with the reference prompt. */
export async function extractSectionFacts(args: {
  provider: LLMProvider;
  page: WikiPage;
  snapshot: WikiSnapshot;
  section: WikiSection;
  hintFor: (attribute: string) => NormalizeHint | undefined;
  now: string;
}): Promise<SectionExtraction> {
  const { provider, page, snapshot, section } = args;
  const out = await runTask(provider, extractReferenceTask({ title: page.title, space: page.space, headingPath: section.headingPath, declaredScope: page.declaredScope, section: section.text }));

  const facts = new Map<string, ReferenceFact>();
  const scopeUndeclared: string[] = [];
  let droppedNotVerbatim = 0;
  for (const raw of out.claims) {
    const built = buildClaimCore(raw, { text: section.text, start: section.start }, page.declaredScope, args.hintFor, args.now);
    if (!built) {
      droppedNotVerbatim++;
      continue;
    }
    const id = referenceFactId(`rf-${createHash('sha1').update(`${section.id}|${raw.quote}|${raw.attribute}|${raw.valueRaw}`).digest('hex').slice(0, 16)}`);
    if (facts.has(id)) continue;
    facts.set(id, ReferenceFactSchema.parse({ id, namespace: 'reference', origin: 'reference', sourceId: page.id, snapshotId: snapshot.id, passageId: section.id, ...built.core }));
    if (built.scopeUndeclared) scopeUndeclared.push(id);
  }
  return { facts: [...facts.values()], raw: out.claims.length, droppedNotVerbatim, scopeUndeclared, injection: detectInjection(section.text) };
}
