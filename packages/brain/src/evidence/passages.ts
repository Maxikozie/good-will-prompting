import { MAX_SECTION_TOKENS, approxTokens, splitByHeadings, type TextSpan } from '../domain';

export type PassageSpan = TextSpan;
export { approxTokens };
export const MAX_PASSAGE_TOKENS = MAX_SECTION_TOKENS;

/** Passages of a case document: heading-aware split with offsets (shared splitter in domain/split.ts). */
export const splitPassages = (text: string, maxTokens = MAX_PASSAGE_TOKENS): PassageSpan[] => splitByHeadings(text, maxTokens);
