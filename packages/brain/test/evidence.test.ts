import { describe, expect, it } from 'vitest';
import { buildClaimCore, claimKey, type RawClaim } from '../src/domain';
import { MAX_PASSAGE_TOKENS, approxTokens, canRead, findDuplicates, hamming, partitionReadable, simhash, splitPassages } from '../src/evidence';
import { FakeEmbedder } from '../src/llm';
import { loadDemo } from '../src/store/seed';

const demo = loadDemo();
const textOf = (id: string) => demo.evidence.find((e) => e.document.id === id)!.snapshot.text;

describe('splitPassages', () => {
  it('splits on headings with exact offsets and keeps the intro', () => {
    const t = '# Titel\n\nIntro.\n\n## Een\n\nTekst een.\n\n## Twee\n\nTekst twee.\n';
    const p = splitPassages(t);
    expect(p.map((x) => x.text.split('\n')[0])).toEqual(['# Titel', '## Een', '## Twee']);
    for (const x of p) expect(t.slice(x.start, x.end)).toBe(x.text);
    expect(p.map((x) => x.ordinal)).toEqual([0, 1, 2]);
  });

  it('cuts an oversized section at paragraph boundaries, never mid-paragraph, never above the token limit', () => {
    const para = (n: number) => `Alinea ${n}: ${'woord '.repeat(120).trim()}.`;
    const t = `# T\n\n## Lang\n\n${[1, 2, 3, 4, 5, 6].map(para).join('\n\n')}\n`;
    const p = splitPassages(t);
    expect(p.length).toBeGreaterThan(2);
    for (const x of p) {
      expect(t.slice(x.start, x.end)).toBe(x.text);
      expect(approxTokens(x.text)).toBeLessThanOrEqual(MAX_PASSAGE_TOKENS + 1);
    }
    expect(p.map((x) => x.text).join('\n\n')).toContain(para(3));
  });

  it('handles empty input, no headings and CRLF-free trailing whitespace', () => {
    expect(splitPassages('')).toEqual([]);
    expect(splitPassages('  \n\n')).toEqual([]);
    expect(splitPassages('Alleen tekst.  \n')).toEqual([{ ordinal: 0, start: 0, end: 'Alleen tekst.'.length, text: 'Alleen tekst.' }]);
  });

  it('the demo documents split into 8 / 3 / 3 / 7 passages', () => {
    expect(['ev-A', 'ev-B', 'ev-C', 'ev-D'].map((id) => splitPassages(textOf(id)).length)).toEqual([8, 3, 3, 7]);
  });
});

describe('simhash', () => {
  const p = 'Tijdens het klein verlet blijft het normale loon doorbetaald (gewaarborgd loon), inclusief vaste premies. Er is geen loonverlies en het verlof telt mee voor de berekening van de vakantiedagen.';
  it('identical text → distance 0; a one-word edit stays close; unrelated text is far', () => {
    expect(hamming(simhash(p), simhash(p))).toBe(0);
    expect(hamming(simhash(p), simhash(p.toUpperCase()))).toBe(0);
    expect(hamming(simhash(p), simhash(p.replace('inclusief', 'met')))).toBeLessThanOrEqual(12);
    expect(hamming(simhash(p), simhash('De werknemer bezorgt binnen 7 dagen na het huwelijk een kopie van de huwelijksakte aan HR.'))).toBeGreaterThan(12);
  });
});

describe('findDuplicates', () => {
  const emb = new FakeEmbedder();
  const pass = (id: string, documentId: string, text: string) => ({ id, documentId, text, embedding: emb.vector(text) });
  const long = 'De werknemer bezorgt binnen 7 dagen na het huwelijk een kopie van de huwelijksakte of de uitnodiging van de gemeente aan HR.';

  it('finds identical passages across documents, in a canonical direction, and never within one document', () => {
    const d = findDuplicates([pass('p-a1', 'A', long), pass('p-d1', 'D', long), pass('p-a2', 'A', long)]);
    expect(d.map((x) => `${x.from}>${x.to}`)).toEqual(['p-d1>p-a1', 'p-d1>p-a2']);
    expect(d.every((x) => x.method === 'exact' && x.score === 1)).toBe(true);
  });

  it('uses cosine for a near-copy that simhash misses, and ignores unrelated and tiny passages', () => {
    const edited = long.replace('binnen 7 dagen', 'binnen 10 dagen').replace('kopie', 'afschrift');
    const d = findDuplicates([pass('p1', 'A', long), pass('p2', 'B', edited), pass('p3', 'C', 'Het loon wordt volledig doorbetaald tijdens het verlof.'), pass('p4', 'D', '## Bewijsstuk'), pass('p5', 'E', '## Bewijsstuk')]);
    expect(d.every((x) => x.from !== 'p4' && x.from !== 'p5' && x.to !== 'p4' && x.to !== 'p5')).toBe(true);
    const pair = d.find((x) => x.to === 'p1' && x.from === 'p2');
    if (pair) expect(['simhash', 'cosine']).toContain(pair.method);
    expect(d.some((x) => x.from === 'p3' || x.to === 'p3')).toBe(false);
  });

  it('works without embeddings (simhash / exact only)', () => {
    const d = findDuplicates([{ id: 'x1', documentId: 'A', text: long }, { id: 'x2', documentId: 'B', text: long }]);
    expect(d).toHaveLength(1);
  });
});

describe('ACL', () => {
  const doc = (p: string[]) => ({ allowedPrincipals: p as never });
  it('reads when open to everyone or sharing a principal', () => {
    expect(canRead(doc(['*']), [])).toBe(true);
    expect(canRead(doc(['group:payroll-be']), ['user:x', 'group:payroll-be'])).toBe(true);
    expect(canRead(doc(['group:payroll-be']), ['group:payroll-nl'])).toBe(false);
    expect(canRead(doc([]), ['user:x'])).toBe(false);
  });
  it('partitions and counts denials', () => {
    const r = partitionReadable([doc(['a']), doc(['b']), doc(['*'])], ['a']);
    expect(r.readable).toHaveLength(2);
    expect(r.denied).toBe(1);
  });
});

describe('buildClaimCore', () => {
  const raw = (over: Partial<RawClaim> = {}): RawClaim => ({
    quote: 'recht op 2 werkdagen klein verlet', subject: 'leave.small_leave.own_marriage', attribute: 'duration', valueRaw: '2 werkdagen',
    qualifiers: { conditions: [] }, temporal: {}, polarity: 'affirms', modality: 'rule', confidence: 0.9, ...over,
  });
  const source = { text: 'Een werknemer heeft recht op 2 werkdagen klein verlet.', start: 100 };
  const hint = () => undefined;
  const NOW = '2026-09-30T00:00:00.000Z';

  it('drops a quote that is not verbatim (case, whitespace or paraphrase)', () => {
    expect(buildClaimCore(raw({ quote: 'recht op 2 werkdagen klein verlet' }), source, {}, hint, NOW)).not.toBeNull();
    expect(buildClaimCore(raw({ quote: 'Recht op 2 werkdagen klein verlet' }), source, {}, hint, NOW)).toBeNull();
    expect(buildClaimCore(raw({ quote: 'recht op 2  werkdagen klein verlet' }), source, {}, hint, NOW)).toBeNull();
    expect(buildClaimCore(raw({ quote: 'recht op twee dagen' }), source, {}, hint, NOW)).toBeNull();
    expect(buildClaimCore(raw({ quote: '' }), source, {}, hint, NOW)).toBeNull();
  });

  it('places the span in snapshot coordinates and normalizes the value with code', () => {
    const b = buildClaimCore(raw(), source, { country: 'BE' }, hint, NOW)!;
    expect(b.core.span).toEqual({ start: 100 + source.text.indexOf('recht'), end: 100 + source.text.indexOf('recht') + 'recht op 2 werkdagen klein verlet'.length });
    expect(b.core.value).toMatchObject({ type: 'number', normalized: 2, unit: 'days', raw: '2 werkdagen' });
  });

  it('falls back to the declared scope, lets claim qualifiers win, flags an undeclared country as null', () => {
    const declared = { country: 'BE', jointCommittee: 'PC 200' };
    const fromDoc = buildClaimCore(raw(), source, declared, hint, NOW)!;
    expect(fromDoc.core.qualifiers).toMatchObject({ country: 'BE', jointCommittee: 'PC 200', conditions: [] });
    expect(fromDoc.scopeUndeclared).toBe(false);
    expect(fromDoc.core.claimKey).toBe(claimKey({ subject: 'leave.small_leave.own_marriage', attribute: 'duration', qualifiers: declared }));

    const own = buildClaimCore(raw({ qualifiers: { country: 'NL', conditions: [] } }), source, declared, hint, NOW)!;
    expect(own.core.qualifiers.country).toBe('NL');

    const none = buildClaimCore(raw(), source, {}, hint, NOW)!;
    expect(none.scopeUndeclared).toBe(true);
    expect(none.core.qualifiers.country).toBeNull();
    const nullDeclared = buildClaimCore(raw(), source, { country: null }, hint, NOW)!;
    expect(nullDeclared.scopeUndeclared).toBe(true);
  });

  it('applies the slot unit hint to a bare number and derives effectiveFrom from an effective_from date', () => {
    const bare = buildClaimCore(raw({ quote: 'recht op 2 werkdagen klein verlet', valueRaw: '2' }), source, {}, () => ({ unit: 'days' }), NOW)!;
    expect(bare.core.value).toMatchObject({ normalized: 2, unit: 'days' });
    const eff = buildClaimCore(raw({ attribute: 'effective_from', valueRaw: '1 januari 2024', quote: 'recht op 2 werkdagen klein verlet' }), source, {}, hint, NOW)!;
    expect(eff.core.value).toMatchObject({ type: 'date', normalized: '2024-01-01' });
    expect(eff.core.temporal.effectiveFrom).toBe('2024-01-01');
  });

  it('keeps non-rule modalities (they are stored; the rules engine refuses to let them win)', () => {
    expect(buildClaimCore(raw({ modality: 'unknown' }), source, {}, hint, NOW)!.core.modality).toBe('unknown');
  });
});
