import { LLMError } from './errors';

export type FetchFn = typeof fetch;

/** Only http(s) base URLs from operator-set env are accepted (never from documents or requests). */
export function parseBaseUrl(raw: string, what: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new LLMError(`${what}: "${raw}" is not a valid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new LLMError(`${what}: only http(s) URLs are allowed`);
  return u.toString().replace(/\/+$/, '');
}

export async function postJson(fetchFn: FetchFn, url: string, body: unknown, opts: { headers?: Record<string, string>; timeoutMs: number; what: string }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    throw new LLMError(`${opts.what}: request failed (${e instanceof Error ? e.name : 'error'})`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new LLMError(`${opts.what}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  try {
    return await res.json();
  } catch {
    throw new LLMError(`${opts.what}: response was not JSON`);
  }
}
