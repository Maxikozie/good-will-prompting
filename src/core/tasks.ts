import type { Country, IssueType, Person, QueryContext, Task, WikiPage } from './types';
import { loadOrg } from './org';
import { buildVerdict, inScope } from './trust';
import { isOrphan, lintVault } from './health';
import { renderBody } from './ingest';
import { COUNTRY_NAMES, extractValue, fmtDate, newId, now, sha256, slug, today } from './util';
import { getPage, listPages, loadTasks, putRaw, savePage, saveTasks } from './vault';

// The fix loop: a problem found while answering becomes a task for the owner; resolving it verifies the page.

export class TaskError extends Error {}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export interface FlagInput {
  topic: string; // page id or topic id
  issue: IssueType;
  note: string;
  context?: QueryContext;
  created_by?: string;
}

function scopeLabel(client: string | null, country: Country | null): string {
  return [client, country].filter(Boolean).join(' ');
}

export function flagForOwner(input: FlagInput): { task: Task; created: boolean } {
  const org = loadOrg();
  const page = getPage(input.topic);
  const topic = page ? org.topic(page.topic) : org.topic(input.topic);
  if (!page && !topic) throw new TaskError(`Unknown topic "${input.topic}". Use a page id or topic id from knowledge_health.`);

  const country: Country | null = input.context?.country ?? page?.country ?? null;
  const client: string | null = input.context?.client ?? page?.client ?? null;
  const pageLevel = !!page && (input.issue === 'orphan' || input.issue === 'stale' || input.issue === 'unverified');
  const topicId = pageLevel ? page!.id : (topic?.id ?? page!.topic);

  // dedupe: one open task per topic + issue + scope
  const tasks = loadTasks();
  const existing = tasks.find(
    (t) => t.status === 'open' && t.topic === topicId && t.issue === input.issue && t.country === country && norm(t.client) === norm(client),
  );
  if (existing) return { task: existing, created: false };

  // who gets it: page owner, the accountable client owner, or the team lead when nobody owns it
  let assignee: Person | null = null;
  let assignee_reason = '';
  const acc = org.accountable(client, country);
  if (pageLevel && !isOrphan(page!)) {
    assignee = org.person(page!.owner);
    assignee_reason = `Owner of "${page!.title}"`;
  } else if (pageLevel) {
    assignee = org.teamLead(page!.owner_team);
    assignee_reason = `Team lead of ${page!.owner_team}: the page has no active owner`;
  } else if (acc) {
    assignee = org.person(acc.owner);
    assignee_reason = `Accountable ${acc.domain} owner for ${acc.client} ${acc.country}`;
  }
  if (!assignee || !assignee.active) {
    assignee = org.teamLead(acc?.team ?? page?.owner_team) ?? org.person(org.teams[0]?.lead);
    assignee_reason = 'Team lead: no active owner for this scope';
  }
  if (!assignee) throw new TaskError('No owner or team lead found for this topic.');

  const pageIds = pageLevel
    ? [page!.id]
    : listPages()
        .filter((p) => p.topic === topicId && !p.superseded_by && inScope(p, { country: country ?? undefined, client: client ?? undefined }))
        .map((p) => p.id);

  let suggested: string | null = null;
  if (topic) {
    const q = `${topic.label} ${client ?? ''} ${country ? COUNTRY_NAMES[country] : ''}`;
    suggested = buildVerdict(q, { country: country ?? undefined, client: client ?? undefined }, { log: false }).recommended?.claim?.text ?? null;
  }
  if (pageLevel) suggested = page!.claims[0]?.text ?? suggested;

  const task: Task = {
    id: newId('task'),
    topic: topicId,
    topic_label: pageLevel ? page!.title : `${topic!.label}${scopeLabel(client, country) ? ` – ${scopeLabel(client, country)}` : ''}`,
    issue: input.issue,
    note: input.note,
    country,
    client,
    page_ids: pageIds,
    assignee: assignee.id,
    assignee_reason,
    suggested_claim: suggested,
    status: 'open',
    created_at: now().toISOString(),
    created_by: input.created_by ?? 'trustlayer',
    resolved_at: null,
    resolved_by: null,
    verified_claim: null,
    result_page_id: null,
  };
  saveTasks([task, ...tasks]);
  return { task, created: true };
}

export interface ResolveInput {
  task_id: string;
  verified_claim: string;
  resolved_by: string;
}

export function resolveTask(input: ResolveInput): { task: Task; page: WikiPage; superseded: string[] } {
  const org = loadOrg();
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === input.task_id);
  if (!task) throw new TaskError('Task not found.');
  if (task.status !== 'open') throw new TaskError('Task is already resolved.');
  const resolver = org.person(input.resolved_by);
  if (!resolver || !resolver.active) throw new TaskError('Unknown or inactive person.');
  // MOCK auth: identity is taken from the request. Rule enforced: only the assignee or their team lead may verify.
  const assignee = org.person(task.assignee);
  const lead = org.teamLead(assignee?.team);
  if (resolver.id !== task.assignee && resolver.id !== lead?.id) {
    throw new TaskError(`Only ${assignee?.name ?? 'the assignee'}${lead ? ` or ${lead.name}` : ''} can resolve this task.`);
  }

  const claimText = input.verified_claim.trim();
  const value = extractValue(claimText);
  const at = now().toISOString();
  const day = today();
  let result: WikiPage;
  const superseded: string[] = [];

  const target = getPage(task.topic);
  if (target && (task.issue === 'orphan' || task.issue === 'stale' || task.issue === 'unverified')) {
    // page-level fix: the owner confirms (or corrects) the page
    const topicId = target.topic;
    target.claims = [{ ...(target.claims[0] ?? { topic: topicId }), topic: topicId, value, text: claimText }];
    target.last_verified = day;
    target.last_edited = day;
    target.author = resolver.id;
    if (isOrphan(target)) target.owner = resolver.id;
    target.body = `${target.body}\n\n## Verification\n- ${fmtDate(day)}: verified by [[${resolver.name}]] (task ${task.id}): ${claimText}`;
    savePage(target);
    result = target;
  } else {
    // topic-level fix: write one verified page for topic + scope and supersede the fragments
    const topic = org.topic(task.topic);
    if (!topic) throw new TaskError('Task topic no longer exists.');
    const id = slug(`${task.client ?? 'all'}-${task.country ?? 'all'}-${topic.id}`);
    const involved = task.page_ids.filter((pid) => pid !== id).map((pid) => getPage(pid)).filter((p): p is WikiPage => !!p);
    const existing = getPage(id);
    const record = JSON.stringify({ type: 'resolution', task_id: task.id, topic: topic.id, country: task.country, client: task.client, verified_claim: claimText, resolved_by: resolver.id, resolved_at: at, involved: involved.map((p) => p.id) }, null, 2);
    const hash = sha256(record);
    putRaw(hash, record, { source_id: task.id, origin: 'internal', original: `resolution/${task.id}`, ingested_at: at, ext: 'json' });

    const winners = involved.filter((p) => p.claims.find((c) => c.topic === topic.id)?.value === value);
    const effective = winners.map((p) => p.claims.find((c) => c.topic === topic.id)?.effective_from).find(Boolean);
    const acc = org.accountable(task.client, task.country);
    const owner = acc && org.person(acc.owner)?.active ? acc.owner : resolver.id;
    const scope = scopeLabel(task.client, task.country);
    const meta: Omit<WikiPage, 'body'> = {
      id,
      title: `${topic.label}${scope ? ` – ${scope}` : ''}`,
      topic: topic.id,
      owner,
      owner_team: org.person(owner)?.team ?? null,
      author: resolver.id,
      country: task.country,
      client: task.client,
      product: involved.find((p) => p.product)?.product ?? null,
      source_type: 'policy',
      origin: 'internal',
      location: `vault/wiki/${id}.md`,
      created: existing?.created ?? day,
      last_edited: day,
      last_verified: day,
      status: 'verified',
      sources: [...new Set([hash, ...involved.flatMap((p) => p.sources), ...(existing?.sources ?? [])])],
      supersedes: [...new Set([...(existing?.supersedes ?? []), ...involved.filter((p) => !winners.includes(p) || (p.source_type !== 'teams' && p.source_type !== 'email')).map((p) => p.id)])],
      superseded_by: null,
      captured_in: null,
      claims: [{ topic: topic.id, value, text: claimText, ...(effective ? { effective_from: effective } : {}) }],
    };
    const history = [
      `## Resolution history`,
      `- ${fmtDate(day)}: verified by [[${resolver.name}]] via task ${task.id} (${task.issue}).`,
      ...involved.map((p) => {
        const c = p.claims.find((x) => x.topic === topic.id);
        const kept = winners.includes(p) && (p.source_type === 'teams' || p.source_type === 'email');
        return `  - [[${p.id}]] said **${c?.value ?? '?'}**: ${kept ? 'captured here' : 'superseded'}`;
      }),
    ].join('\n');
    result = { ...meta, body: renderBody(meta, `**Verified answer:** ${claimText}\n\n${history}`) };
    savePage(result);

    for (const p of involved) {
      const kept = winners.includes(p) && (p.source_type === 'teams' || p.source_type === 'email');
      if (kept) p.captured_in = id;
      else {
        p.superseded_by = id;
        superseded.push(p.id);
      }
      savePage(p);
    }
  }

  task.status = 'resolved';
  task.resolved_at = at;
  task.resolved_by = resolver.id;
  task.verified_claim = claimText;
  task.result_page_id = result.id;
  // resolving a topic also closes other open tasks on the same topic + scope
  for (const t of tasks) {
    if (t !== task && t.status === 'open' && t.topic === task.topic && t.country === task.country && norm(t.client) === norm(task.client)) {
      t.status = 'resolved';
      t.resolved_at = at;
      t.resolved_by = resolver.id;
      t.verified_claim = claimText;
      t.result_page_id = result.id;
    }
  }
  saveTasks(tasks);
  lintVault();
  return { task, page: getPage(result.id) ?? result, superseded };
}
