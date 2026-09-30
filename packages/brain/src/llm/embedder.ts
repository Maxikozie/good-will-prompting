import { LIMITS } from '../security/limits';
import { EmbeddingInputSchema } from '../security/model';
import { reserveModelCall } from '../security/budget';
import { boundText } from '../security/input';
import type { Embedder } from './types';

export { OllamaEmbedder } from './ollama';

const DIMENSIONS = 768;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const tokenize = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Deterministic feature-hashing embedder for tests and the offline demo (768 dims, unit length).
 * Unigrams + bigrams are hashed into signed buckets, so near-identical texts land very close in cosine
 * similarity (a one-word edit in a paragraph stays ≥ 0.93, the circularity-guard threshold) and unrelated texts stay low.
 * No model, no network: same text in, same vector out, on every machine.
 */
export class FakeEmbedder implements Embedder {
  readonly budgetsManaged = true as const;
  readonly modelId = 'fake-hash-768';
  readonly dimensions = DIMENSIONS;

  async embed(texts: readonly string[]): Promise<number[][]> {
    EmbeddingInputSchema.max(LIMITS.embeddingBatch).parse(texts);
    if (texts.length) await reserveModelCall(texts, 0);
    return texts.map((t) => this.vector(t));
  }

  vector(text: string): number[] {
    boundText(text);
    const v = new Array<number>(DIMENSIONS).fill(0);
    const toks = tokenize(text);
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      v[h % DIMENSIONS]! += (h & 0x80000000 ? -1 : 1) * weight; // bucket from the low bits, sign from the top bit
    };
    toks.forEach((t, i) => {
      add(`u:${t}`, 1);
      if (i + 1 < toks.length) add(`b:${t} ${toks[i + 1]}`, 0.7);
    });
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (norm === 0) {
      v[0] = 1; // empty text: a fixed unit vector, still deterministic
      return v;
    }
    return v.map((x) => x / norm);
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
