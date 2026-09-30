import { cosine } from '../llm/embedder';
import { hamming, simhash, tokens } from './simhash';

export const SIMHASH_MAX_DISTANCE = 3; // SPEC §1: Hamming ≤ 3
export const COSINE_MIN = 0.93; // SPEC §1: cosine ≥ 0.93
export const MIN_DUPLICATE_TOKENS = 6; // very short passages (a bare heading) are never "duplicates"

export interface DupPassage {
  id: string;
  documentId: string;
  text: string;
  embedding?: readonly number[];
}

export interface DuplicateMatch {
  /** Canonical direction: the larger passage id points at the smaller one, so a pair is never reported twice. */
  from: string;
  to: string;
  method: 'exact' | 'simhash' | 'cosine';
  score: number;
}

const squash = (s: string) => tokens(s).join(' ');

/** Cross-document duplicate passages: identical text, SimHash distance ≤ 3, or embedding cosine ≥ 0.93. Same-document pairs are ignored. */
export function findDuplicates(passages: readonly DupPassage[]): DuplicateMatch[] {
  const prepared = passages
    .filter((p) => tokens(p.text).length >= MIN_DUPLICATE_TOKENS)
    .map((p) => ({ p, hash: simhash(p.text), norm: squash(p.text) }));
  const out: DuplicateMatch[] = [];
  for (let i = 0; i < prepared.length; i++) {
    for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i]!;
      const b = prepared[j]!;
      if (a.p.documentId === b.p.documentId) continue;
      let method: DuplicateMatch['method'] | null = null;
      let score = 0;
      if (a.norm === b.norm) {
        method = 'exact';
        score = 1;
      } else {
        const d = hamming(a.hash, b.hash);
        if (d <= SIMHASH_MAX_DISTANCE) {
          method = 'simhash';
          score = 1 - d / 64;
        } else if (a.p.embedding && b.p.embedding) {
          const c = cosine(a.p.embedding, b.p.embedding);
          if (c >= COSINE_MIN) {
            method = 'cosine';
            score = Math.min(1, c);
          }
        }
      }
      if (!method) continue;
      const [from, to] = a.p.id > b.p.id ? [a.p.id, b.p.id] : [b.p.id, a.p.id];
      out.push({ from, to, method, score });
    }
  }
  return out.sort((x, y) => (x.from + x.to).localeCompare(y.from + y.to));
}
