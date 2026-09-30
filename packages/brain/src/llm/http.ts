import { z } from 'zod';
import { LLMError } from './errors';
import { LIMITS } from '../security/limits';
import { deadline } from '../security/runtime';
import { parseJson } from '../security/input';
import { ResourceError } from '../security/errors';
export type FetchFn = typeof fetch;
export function parseBaseUrl(raw: string, what: string): string {
  const result = z.string().max(4096).url().safeParse(raw);
  if (!result.success) throw new LLMError(`${what}: invalid URL`);
  const u = new URL(result.data);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new LLMError(`${what}: only http(s) URLs without credentials are allowed`);
  const value = u.toString();
  let end = value.length;
  while (value[end - 1] === '/') end--;
  return value.slice(0, end);
}
export async function postJson(fetchFn: FetchFn, url: string, body: unknown, opts: { headers?: Record<string, string>; timeoutMs: number; what: string }): Promise<unknown> {
  const ms = z.number().int().positive().max(LIMITS.llmTimeoutMs).parse(opts.timeoutMs);
  const controller = new AbortController();
  return deadline(async () => {
    let res: Response;
    try { res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...opts.headers }, body: JSON.stringify(body), signal: controller.signal }); }
    catch { throw new LLMError(`${opts.what}: request failed`); }
    if (!res.ok) { await res.body?.cancel(); throw new LLMError(`${opts.what}: HTTP ${res.status}`); }
    return readResponseJson(res);
  }, ms, () => controller.abort());
}

export async function readResponseJson(res: Response): Promise<unknown> {
    const reader = res.body?.getReader();
    if (!reader) throw new LLMError('Empty model response');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > LIMITS.modelResponseBytes) throw new ResourceError(413, 'Model response too large');
        chunks.push(next.value);
      }
      return parseJson(Buffer.concat(chunks).toString('utf8'), LIMITS.modelResponseBytes);
    } finally { await reader.cancel().catch(() => {}); }
}
