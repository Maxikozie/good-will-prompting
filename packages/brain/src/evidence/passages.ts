export interface PassageSpan {
  ordinal: number;
  start: number;
  end: number;
  text: string;
}

/** ~4 characters per token: good enough to bound passage size without a tokenizer. */
export const approxTokens = (s: string) => Math.ceil(s.length / 4);
export const MAX_PASSAGE_TOKENS = 400;

function paragraphs(section: string, base: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const part of section.split(/\n{2,}/)) {
    const at = section.indexOf(part, cursor);
    out.push({ start: base + at, end: base + at + part.length });
    cursor = at + part.length;
  }
  return out;
}

/**
 * Heading-aware split (SPEC §5 stage 10): the intro (title + lead-in) is one passage, every `## heading` starts a new one,
 * and a section longer than `maxTokens` is cut at paragraph boundaries. Offsets index into `text`; `text.slice(start, end)`
 * is exactly the passage. Headings are the semantic units, so small sections are NOT merged: that keeps passages of two
 * versions of the same document identical wherever the text is identical (which is what duplicate detection relies on).
 */
export function splitPassages(text: string, maxTokens = MAX_PASSAGE_TOKENS): PassageSpan[] {
  const starts = [0, ...[...text.matchAll(/^## .+$/gm)].map((m) => m.index)];
  const out: PassageSpan[] = [];
  const push = (start: number, end: number) => {
    const body = text.slice(start, end).trimEnd();
    if (body.trim()) out.push({ ordinal: out.length, start, end: start + body.length, text: body });
  };
  starts.forEach((s, i) => {
    const e = i + 1 < starts.length ? starts[i + 1]! : text.length;
    const section = text.slice(s, e).trimEnd();
    if (approxTokens(section) <= maxTokens) return push(s, e);
    let from = -1;
    let to = -1;
    for (const p of paragraphs(section, s)) {
      if (from < 0) {
        from = p.start;
        to = p.end;
      } else if (approxTokens(text.slice(from, p.end)) <= maxTokens) {
        to = p.end;
      } else {
        push(from, to);
        from = p.start;
        to = p.end;
      }
    }
    if (from >= 0) push(from, to);
  });
  return out;
}
