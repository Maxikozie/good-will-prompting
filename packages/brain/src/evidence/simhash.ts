import { boundText } from '../security/input';
const MASK = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

function fnv64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK;
  }
  return h;
}

export const tokens = (s: string): string[] =>
  boundText(s)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** 64-bit SimHash over word unigrams and bigrams. Identical text → identical hash; a small edit flips only a few bits. */
export function simhash(text: string): bigint {
  const toks = tokens(text);
  const weights = new Array<number>(64).fill(0);
  const add = (feature: string) => {
    const h = fnv64(feature);
    for (let b = 0; b < 64; b++) weights[b]! += (h >> BigInt(b)) & 1n ? 1 : -1;
  };
  toks.forEach((t, i) => {
    add(`u:${t}`);
    if (i + 1 < toks.length) add(`b:${t} ${toks[i + 1]}`);
  });
  let out = 0n;
  for (let b = 0; b < 64; b++) if (weights[b]! > 0) out |= 1n << BigInt(b);
  return out;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
