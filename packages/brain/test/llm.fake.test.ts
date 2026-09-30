import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeEmbedder, FakeProvider, LLMError, MissingFixtureError, OllamaEmbedder, cosine, inputHash, type Message } from '../src/llm';
import { evidenceRepo, pgliteDb, referenceRepo, type Db } from '../src/store';
import { loadDemo, seedDemo } from '../src/store/seed';

const Out = z.object({ n: z.number() });
const MSGS: Message[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'give n' },
];

describe('FakeProvider', () => {
  it('replays a fixture keyed by (promptId, input hash)', async () => {
    const f = new FakeProvider();
    f.register('p', MSGS, { n: 1 });
    expect(await f.completeJSON(Out, MSGS, { promptId: 'p', promptVersion: 'v1' })).toEqual({ n: 1 });
    expect(f.calls).toEqual([{ promptId: 'p', inputHash: inputHash(MSGS) }]);
  });

  it('FAILS LOUDLY on a missing fixture: other input, other promptId, or an empty provider', async () => {
    const f = new FakeProvider();
    f.register('p', MSGS, { n: 1 });
    const changed: Message[] = [...MSGS.slice(0, 1), { role: 'user', content: 'give n!' }];
    await expect(f.completeJSON(Out, changed, { promptId: 'p', promptVersion: 'v1' })).rejects.toThrow(MissingFixtureError);
    await expect(f.completeJSON(Out, MSGS, { promptId: 'other', promptVersion: 'v1' })).rejects.toThrow(MissingFixtureError);
    const err = await new FakeProvider().completeJSON(Out, MSGS, { promptId: 'p', promptVersion: 'v1' }).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.message).toMatch(/brain:record/);
    expect(err.message).toContain(inputHash(MSGS));
  });

  it('does not retry or fall back: a stale fixture (no longer matches the schema) throws too', async () => {
    const f = new FakeProvider();
    f.register('p', MSGS, { n: 'stale' });
    await expect(f.completeJSON(Out, MSGS, { promptId: 'p', promptVersion: 'v1' })).rejects.toThrow(/no longer matches the schema/);
    f.register('q', MSGS, { n: 1 });
    await expect(f.completeJSON(Out, MSGS, { promptId: 'q', promptVersion: 'v1', check: () => 'nope' })).rejects.toThrow(/fails its check/);
  });

  it('loads fixtures from a directory (and an absent directory is simply empty)', () => {
    expect(FakeProvider.fromDir('/definitely/not/here').size).toBe(0);
  });
});

describe('FakeEmbedder', () => {
  const e = new FakeEmbedder();
  const demo = loadDemo();
  const A = demo.evidence.find((x) => x.document.id === 'ev-A')!;
  const D = demo.evidence.find((x) => x.document.id === 'ev-D')!;
  const C = demo.evidence.find((x) => x.document.id === 'ev-C')!;
  const W2 = demo.reference.find((x) => x.page.id === 'wiki-W2')!;
  const W4 = demo.reference.find((x) => x.page.id === 'wiki-W4')!;
  const passage = (d: typeof A, needle: string) => d.passages.find((p) => p.text.includes(needle))!.text;

  it('gives unit-length, 768-dimensional, deterministic vectors', async () => {
    const [v1] = await e.embed(['Klein verlet bij eigen huwelijk']);
    const [v2] = await e.embed(['Klein verlet bij eigen huwelijk']);
    expect(v1).toHaveLength(768);
    expect(v1).toEqual(v2);
    expect(Math.sqrt(v1!.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 10);
    expect(e.dimensions).toBe(768);
    expect(await e.embed([])).toEqual([]);
    const [empty] = await e.embed(['']);
    expect(empty!.every(Number.isFinite)).toBe(true);
  });

  it('is case-, punctuation- and diacritic-insensitive', () => {
    expect(cosine(e.vector('De werkgever kan ze niet weigeren.'), e.vector('de WERKGEVER kan ze niet weigeren'))).toBeCloseTo(1, 10);
    expect(cosine(e.vector('anciënniteit'), e.vector('ANCIENNITEIT'))).toBeCloseTo(1, 10);
  });

  it('identical passages (A vs D) score 1; a one-word edit stays ≥ 0.93 (circularity threshold)', () => {
    const a = passage(A, 'Wie heeft recht');
    expect(cosine(e.vector(a), e.vector(passage(D, 'Wie heeft recht')))).toBeCloseTo(1, 10);
    const edited = a.replace('lopende', 'bestaande');
    expect(edited).not.toBe(a);
    expect(cosine(e.vector(a), e.vector(edited))).toBeGreaterThanOrEqual(0.93);
    const longer = passage(A, 'Wanneer op te nemen');
    expect(cosine(e.vector(longer), e.vector(longer.replace('14 kalenderdagen', '10 kalenderdagen')))).toBeGreaterThanOrEqual(0.93);
  });

  it('A and its wiki copy W2 are near-identical, unrelated documents are not', () => {
    const fullA = A.snapshot.text;
    expect(cosine(e.vector(fullA), e.vector(W2.snapshot.text))).toBeGreaterThanOrEqual(0.93);
    expect(cosine(e.vector(fullA), e.vector(D.snapshot.text))).toBeGreaterThan(0.8);
    expect(cosine(e.vector(fullA), e.vector(C.snapshot.text))).toBeLessThan(0.7); // same topic words, but nowhere near the 0.93 copy threshold
    expect(cosine(e.vector(passage(A, 'Bewijsstuk')), e.vector(W4.snapshot.text))).toBeLessThan(0.3);
  });

  describe('with pgvector', () => {
    let db: Db;
    beforeAll(async () => {
      db = await pgliteDb();
      await seedDemo(db);
    });
    afterAll(async () => db.close());

    it('nearest passages to a D passage are the identical passage in A and D itself', async () => {
      const all = demo.evidence.flatMap((x) => x.passages);
      const vecs = await e.embed(all.map((p) => p.text));
      for (let i = 0; i < all.length; i++) await evidenceRepo.setPassageEmbedding(db, all[i]!.id, vecs[i]!);
      const target = D.passages.find((p) => p.text.includes('Wie heeft recht'))!;
      const hits = await evidenceRepo.searchPassages(db, e.vector(target.text), { k: 3 });
      expect(hits.slice(0, 2).map((h) => h.passage.text)).toEqual([target.text, target.text]);
      expect(hits[0]!.score).toBeGreaterThan(0.999);
      expect(hits[2]!.score).toBeLessThan(0.6);

      const sections = demo.reference.flatMap((x) => x.sections);
      const svecs = await e.embed(sections.map((s) => s.text));
      for (let i = 0; i < sections.length; i++) await referenceRepo.setSectionEmbedding(db, sections[i]!.id, svecs[i]!);
      const ref = await referenceRepo.searchSections(db, e.vector(target.text), { k: 1 });
      expect(ref[0]!.section.text).toBe(target.text); // W2 holds a verbatim copy of the same section
    });
  });
});

describe('OllamaEmbedder', () => {
  const ok = (embeddings: number[][]) => new Response(JSON.stringify({ embeddings }), { status: 200 });
  const vec = () => new Array<number>(768).fill(0.1);

  it('posts nomic-embed-text with the batch input and returns the vectors in order', async () => {
    const fetchMock = vi.fn(async (_u: unknown, _i?: RequestInit) => ok([vec(), vec()]));
    const emb = new OllamaEmbedder({ host: 'http://ollama.test:11434', fetch: fetchMock as never });
    expect(emb.modelId).toBe('ollama:nomic-embed-text');
    expect(await emb.embed(['a', 'b'])).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://ollama.test:11434/api/embed');
    expect(JSON.parse(String(init!.body))).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
  });

  it('rejects a wrong count or dimension, and skips the call for empty input', async () => {
    const fetchMock = vi.fn(async () => ok([vec()]));
    const emb = new OllamaEmbedder({ fetch: fetchMock as never });
    await expect(emb.embed(['a', 'b'])).rejects.toThrow(/number of embeddings/);
    await expect(new OllamaEmbedder({ fetch: (async () => ok([[1, 2, 3]])) as never }).embed(['a'])).rejects.toThrow(/768/);
    fetchMock.mockClear();
    expect(await emb.embed([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

