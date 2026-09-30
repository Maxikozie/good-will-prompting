import type { HealthReport, IssueType, Person, QueryContext, Task, Verdict, WikiPage } from '../../src/core/types';

// Typed fetch helpers. Same-origin /api only.

export interface AssistantResult {
  id: string;
  title: string;
  location: string;
  snippet: string;
  relevance: number;
}

export interface AssistantResponse {
  assistant: string;
  results: AssistantResult[];
}

// MOCK login: the signed-in agent on the live call.
export const CALL_AGENT = 'nina.maes';

async function call<T>(path: string, opts: { method?: string; body?: unknown; user?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.user) headers['x-mock-user'] = opts.user; // MOCK auth header
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issues = Array.isArray(data?.issues) ? ` (${data.issues.join('; ')})` : '';
    throw new Error(`${data?.error ?? `Request failed (${res.status})`}${issues}`);
  }
  return data as T;
}

export const api = {
  assistant: (q: string) => call<AssistantResponse>(`/assistant?q=${encodeURIComponent(q)}`, { user: CALL_AGENT }),
  verify: (question: string, results: AssistantResult[]) =>
    call<Verdict>('/verify', {
      method: 'POST',
      user: CALL_AGENT,
      body: { question, sources: results.map(({ id, title, location, snippet }) => ({ id, title, location, snippet })) },
    }),
  health: () => call<HealthReport>('/health'),
  tasks: () => call<Task[]>('/tasks'),
  people: () => call<Person[]>('/people'),
  page: (id: string) => call<WikiPage>(`/pages/${encodeURIComponent(id)}`),
  flag: (topic: string, issue: IssueType, note: string, context: QueryContext | undefined, user: string) =>
    call<{ task: Task; created: boolean }>('/tasks', { method: 'POST', user, body: context ? { topic, issue, note, context } : { topic, issue, note } }),
  resolve: (taskId: string, verified_claim: string, resolved_by: string) =>
    call<{ task: Task; page: WikiPage; superseded: string[] }>(`/tasks/${encodeURIComponent(taskId)}/resolve`, {
      method: 'POST',
      user: resolved_by,
      body: { verified_claim, resolved_by },
    }),
  reset: () => call<unknown>('/demo/reset', { method: 'POST' }),
};

/** Strip undefined/null fields so strict zod schemas accept the context. */
export function cleanContext(ctx: { country?: string | null; client?: string | null; product?: string | null }): QueryContext | undefined {
  const out: Record<string, string> = {};
  if (ctx.country) out.country = ctx.country;
  if (ctx.client) out.client = ctx.client;
  if (ctx.product) out.product = ctx.product;
  return Object.keys(out).length ? (out as QueryContext) : undefined;
}
