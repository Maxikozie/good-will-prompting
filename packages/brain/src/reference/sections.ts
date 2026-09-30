import { MAX_SECTION_TOKENS, splitByHeadings, type TextSpan } from '../domain';

export interface SectionSpan extends TextSpan {
  /** e.g. ["Verlofoverzicht België", "Klein verlet"] */
  headingPath: string[];
}

/** Heading-aware sections of a wiki page with their heading path (H1 title, then the `##` heading), offsets into `text`. */
export function splitSections(text: string, maxTokens = MAX_SECTION_TOKENS): SectionSpan[] {
  const h1 = text.match(/^# (.+)$/m)?.[1]?.trim();
  return splitByHeadings(text, maxTokens).map((s) => ({ ...s, headingPath: [h1, s.text.match(/^## (.+)$/m)?.[1]?.trim()].filter((x): x is string => !!x) }));
}
