import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AnthropicProvider,
  DbCache,
  FakeProvider,
  JsonProvider,
  LLMError,
  LLMValidationError,
  MemoryCache,
  OllamaProvider,
  createEmbedder,
  createProvider,
  extractJson,
  inputHash,
  type LLMCache,
  type Message,
} from '../src/llm';
import { migrate, pgliteDb, type Db } from '../src/store';

const Out = z.object({ n: z.number() });
const MSGS: Message[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'give n' },
];
const OPTS = { promptId: 'test', promptVersion: 'v1' };

class Scripted extends JsonProvider {
  readonly modelId = 'scripted';
  readonly seen: Message[][] = [];
  constructor(private readonly outputs: string[], cache?: LLMCache, readonly id = 'scripted') {
    super(cache);
    (this as { modelId: string }).modelId = id;
  }
  protected async raw(messages: readonly Message[]): Promise<string> {
    this.seen.push([...messages]);
    const next = this.outputs.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}

describe('extractJson', () => {
  it.each([
    ['{"n":1}', { n: 1 }],
    ['```json\n{"n":1}\n```', { n: 1 }],
    ['```\n{"n":1}\n```', { n: 1 }],
    ['Sure! Here you go: {"n": 1} Hope that helps.', { n: 1 }],
    ['  [1,2]  ', [1, 2]],
  ])('%s', (input, expected) => expect(extractJson(input)).toEqual(expected));
  it('throws when there is no JSON', () => expect(() => extractJson('no json here')).toThrow());
});

describe('completeJSON: validation and retries', () => {
  it('returns valid output on the first try', async () => {
    const p = new Scripted(['{"n":2}']);
    expect(await p.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 2 });
    expect(p.seen).toHaveLength(1);
  });

  it('feeds the validation error back and succeeds on the 3rd attempt (2 retries)', async () => {
    const p = new Scripted(['this is not json', '{"n":"two"}', '{"n":2}']);
    expect(await p.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 2 });
    expect(p.seen).toHaveLength(3);
    const second = p.seen[1]!;
    expect(second.slice(0, 2)).toEqual(MSGS);
    expect(second[2]).toEqual({ role: 'assistant', content: 'this is not json' });
    expect(second[3]!.role).toBe('user');
    expect(second[3]!.content).toMatch(/rejected/);
    const third = p.seen[2]!;
    expect(third).toHaveLength(6);
    expect(third[5]!.content).toMatch(/n:/); // the zod issue path is in the feedback
  });

  it('gives up after 2 retries with a LLMValidationError', async () => {
    const p = new Scripted(['{"n":"a"}', '{"n":"b"}', '{"n":"c"}', '{"n":1}']);
    const err = await p.completeJSON(Out, MSGS, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(LLMValidationError);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.attempts).toBe(3);
    expect(err.lastOutput).toBe('{"n":"c"}');
    expect(p.seen).toHaveLength(3); // 1 try + 2 retries, never a 4th
  });

  it('accepts fenced / prose-wrapped JSON', async () => {
    const p = new Scripted(['```json\n{"n":3}\n```']);
    expect(await p.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 3 });
  });

  it('runs the extra `check` and retries with its message', async () => {
    const p = new Scripted(['{"n":1}', '{"n":5}']);
    const v = await p.completeJSON(Out, MSGS, { ...OPTS, check: (o) => (o.n < 5 ? 'n must be at least 5' : null) });
    expect(v).toEqual({ n: 5 });
    expect(p.seen[1]!.at(-1)!.content).toMatch(/n must be at least 5/);
  });
});

describe('content-hash cache', () => {
  it('serves a repeated call from the cache (no second model call)', async () => {
    const cache = new MemoryCache();
    const p = new Scripted(['{"n":1}', '{"n":99}'], cache);
    expect(await p.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 1 });
    expect(await p.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 1 });
    expect(p.seen).toHaveLength(1);
  });

  it('misses when the input, prompt version, prompt id or model differs', async () => {
    const cache = new MemoryCache();
    const a = new Scripted(['{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}'], cache);
    await a.completeJSON(Out, MSGS, OPTS);
    await a.completeJSON(Out, [...MSGS, { role: 'user', content: 'more' }], OPTS);
    await a.completeJSON(Out, MSGS, { ...OPTS, promptVersion: 'v2' });
    await a.completeJSON(Out, MSGS, { ...OPTS, promptId: 'other' });
    expect(a.seen).toHaveLength(4);
    const b = new Scripted(['{"n":7}'], cache, 'another-model');
    expect(await b.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 7 });
  });

  it('never caches invalid output, and ignores a stale or corrupt entry', async () => {
    const cache = new MemoryCache();
    const p = new Scripted(['garbage', 'garbage', 'garbage'], cache);
    await expect(p.completeJSON(Out, MSGS, OPTS)).rejects.toThrow(LLMValidationError);
    expect(cache.entries.size).toBe(0);

    await cache.set({ ...OPTS, modelId: 'scripted', inputHash: inputHash(MSGS) }, { n: 'corrupt' });
    const q = new Scripted(['{"n":5}'], cache);
    expect(await q.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 5 });
  });

  describe('brain.llm_cache table', () => {
    let db: Db;
    beforeAll(async () => {
      db = await pgliteDb();
      await migrate(db);
    });
    afterAll(async () => db.close());

    it('stores validated answers, first answer wins, survives a new provider instance', async () => {
      const cache = new DbCache(db);
      const key = { promptId: 'x', promptVersion: 'v1', modelId: 'm', inputHash: 'a'.repeat(64) };
      expect(await cache.get(key)).toBeUndefined();
      await cache.set(key, { n: 1 });
      await cache.set(key, { n: 2 });
      expect(await cache.get(key)).toEqual({ n: 1 });

      const first = new Scripted(['{"n":8}'], cache);
      expect(await first.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 8 });
      const second = new Scripted([], cache); // no outputs left: would throw if it called the model
      expect(await second.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 8 });
      const rows = await db.query<{ n: string }>('SELECT count(*) AS n FROM brain.llm_cache');
      expect(Number(rows.rows[0]!.n)).toBe(2);
    });
  });
});

const okResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('OllamaProvider', () => {
  it('posts temperature 0, a fixed seed, stream=false and the JSON schema as format', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => okResponse({ message: { content: '{"n":4}' } }));
    const p = new OllamaProvider({ host: 'http://ollama.test:11434/', model: 'qwen2.5:7b', fetch: fetchMock as never });
    expect(p.modelId).toBe('ollama:qwen2.5:7b');
    expect(await p.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 4 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://ollama.test:11434/api/chat');
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: 'qwen2.5:7b', stream: false, options: { temperature: 0, seed: 0 }, messages: MSGS });
    expect(body.format).toMatchObject({ type: 'object', properties: { n: { type: 'number' } } });
  });

  it('takes the model from OLLAMA_MODEL', () => {
    vi.stubEnv('OLLAMA_MODEL', 'mistral:7b');
    try {
      expect(new OllamaProvider({ fetch: vi.fn() as never }).modelId).toBe('ollama:mistral:7b');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('turns HTTP and network failures into LLMError', async () => {
    const http500 = new OllamaProvider({ fetch: (async () => new Response('model not found', { status: 500 })) as never });
    await expect(http500.completeJSON(Out, MSGS, OPTS)).rejects.toThrow(/HTTP 500/);
    const down = new OllamaProvider({ fetch: (async () => { throw new TypeError('fetch failed'); }) as never });
    await expect(down.completeJSON(Out, MSGS, OPTS)).rejects.toThrow(LLMError);
    const empty = new OllamaProvider({ fetch: (async () => okResponse({})) as never });
    await expect(empty.completeJSON(Out, MSGS, OPTS)).rejects.toThrow(/no message content/);
  });

  it('only accepts http(s) hosts', () => {
    expect(() => new OllamaProvider({ host: 'file:///etc/passwd' })).toThrow(/http/);
    expect(() => new OllamaProvider({ host: 'not a url' })).toThrow(/valid URL/);
  });
});

describe('AnthropicProvider', () => {
  it('is env-gated: no key, no provider', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      expect(() => new AnthropicProvider()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sends temperature 0, the key header, system prompt separated, and parses text blocks', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => okResponse({ content: [{ type: 'text', text: '{"n":6}' }] }));
    const p = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-test', fetch: fetchMock as never });
    expect(p.modelId).toBe('anthropic:claude-test');
    expect(await p.completeJSON(Out, MSGS, OPTS)).toEqual({ n: 6 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init!.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ model: 'claude-test', temperature: 0, system: 'sys', messages: [{ role: 'user', content: 'give n' }] });
  });

  it('never leaks the API key in errors', async () => {
    const p = new AnthropicProvider({ apiKey: 'sk-very-secret', fetch: (async () => new Response('bad key', { status: 401 })) as never });
    const err = (await p.completeJSON(Out, MSGS, OPTS).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(LLMError);
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain('sk-very-secret');
  });
});

describe('createProvider / createEmbedder', () => {
  it('defaults to ollama and honours BRAIN_LLM_PROVIDER', () => {
    expect(createProvider({}).modelId).toMatch(/^ollama:/);
    expect(createProvider({ BRAIN_LLM_PROVIDER: 'fake' })).toBeInstanceOf(FakeProvider);
    expect(() => createProvider({ BRAIN_LLM_PROVIDER: 'gpt' })).toThrow(/Unknown BRAIN_LLM_PROVIDER/);
  });
  it('anthropic requires a key', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      expect(() => createProvider({ BRAIN_LLM_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('picks the embedder that matches', () => {
    expect(createEmbedder({}).modelId).toBe('ollama:nomic-embed-text');
    expect(createEmbedder({ BRAIN_LLM_PROVIDER: 'fake' }).modelId).toBe('fake-hash-768');
    expect(createEmbedder({ BRAIN_EMBEDDER: 'fake' }).dimensions).toBe(768);
    expect(() => createEmbedder({ BRAIN_EMBEDDER: 'x' })).toThrow();
  });
});
