import type { Conflict, Country, GapItem, HealthIssuePage, HealthReport, HealthTile, PageStatus, Task, WikiPage } from './types';
import { loadOrg } from './org';
import { buildVerdict, conflictId, findConflicts, scorePages } from './trust';
import { STALE_DAYS, TRUST_THRESHOLD, ago, daysSince, fmtDate, now } from './util';
import { listPages, loadQueries, loadTasks, savePage } from './vault';

// The knowledge health radar = the vault "lint" pass: conflicts, orphans, stale pages, unverified changes, gaps.

const PENALTY: Record<PageStatus, number> = { conflict: 1, orphan: 0.8, stale: 0.5, unverified: 0.25, verified: 0, superseded: 0 };
const GAP_PENALTY = 3;

const groupKey = (p: WikiPage) => `${p.topic}|${p.country ?? ''}|${(p.client ?? '').toLowerCase()}`;

function claimFor(p: WikiPage) {
  return p.claims.find((c) => c.topic === p.topic);
}

/** Pages grouped by topic + exact scope, excluding superseded ones. */
function liveGroups(pages: WikiPage[]): Map<string, WikiPage[]> {
  const groups = new Map<string, WikiPage[]>();
  for (const p of pages) {
    if (p.superseded_by || !claimFor(p)) continue;
    const k = groupKey(p);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  return groups;
}

export function isOrphan(p: WikiPage): boolean {
  const owner = loadOrg().person(p.owner);
  return !owner || !owner.active;
}

export function computeStatus(p: WikiPage, groups: Map<string, WikiPage[]>): PageStatus {
  if (p.superseded_by) return 'superseded';
  const group = groups.get(groupKey(p)) ?? [];
  if (new Set(group.map((g) => claimFor(g)!.value)).size > 1) return 'conflict';
  if (isOrphan(p)) return 'orphan';
  if (p.last_verified && daysSince(p.last_verified) > STALE_DAYS) return 'stale';
  if (p.source_type === 'teams' || p.source_type === 'email') {
    if (p.captured_in) return 'verified';
    const mine = claimFor(p);
    const backedByVerifiedDoc = group.some(
      (g) => g !== p && g.last_verified && g.source_type !== 'teams' && g.source_type !== 'email' && claimFor(g)?.value === mine?.value,
    );
    if (backedByVerifiedDoc) return 'verified';
    return daysSince(p.created) > STALE_DAYS ? 'stale' : 'unverified';
  }
  if (!p.last_verified || (p.last_edited && p.last_edited > p.last_verified)) return 'unverified';
  return 'verified';
}

/** Lint pass: recompute every page status and write changes back to the vault frontmatter. */
export function lintVault(): WikiPage[] {
  const pages = listPages();
  const groups = liveGroups(pages);
  for (const p of pages) {
    const s = computeStatus(p, groups);
    if (s !== p.status) {
      p.status = s;
      savePage(p);
    }
  }
  return pages;
}

function openTaskFor(tasks: Task[], topic: string, country: Country | null, client: string | null, pageId?: string): string | null {
  const norm = (s: string | null) => (s ?? '').toLowerCase();
  const t = tasks.find(
    (t) =>
      t.status === 'open' &&
      ((pageId && t.page_ids.includes(pageId) && t.topic === pageId) ||
        (t.topic === topic && t.country === country && norm(t.client) === norm(client))),
  );
  return t?.id ?? null;
}

export function computeGaps(tasks: Task[] = loadTasks()): (GapItem & { open_task_id: string | null })[] {
  const byQuestion = new Map<string, GapItem>();
  for (const q of loadQueries()) {
    const key = q.question.trim().toLowerCase();
    const g = byQuestion.get(key);
    if (g) {
      g.times_asked++;
      if (q.ts > g.last_asked) g.last_asked = q.ts;
    } else {
      byQuestion.set(key, { question: q.question, topic: q.topic, country: q.country, client: q.client, times_asked: 1, last_asked: q.ts, best_score: 0 });
    }
  }
  const gaps: (GapItem & { open_task_id: string | null })[] = [];
  for (const g of byQuestion.values()) {
    // Re-score live: a gap closes by itself once trusted knowledge exists.
    const v = buildVerdict(g.question, {}, { log: false });
    g.best_score = v.recommended?.score ?? 0;
    if (g.best_score < TRUST_THRESHOLD) gaps.push({ ...g, open_task_id: g.topic ? openTaskFor(tasks, g.topic, g.country, g.client) : null });
  }
  return gaps.sort((a, b) => b.times_asked - a.times_asked);
}

export interface HealthScope {
  country?: Country;
  team?: string;
}

export function knowledgeHealth(scope: HealthScope = {}): HealthReport {
  const org = loadOrg();
  const tasks = loadTasks();
  const all = lintVault();
  const inScope = (p: WikiPage) => (!scope.country || p.country === scope.country) && (!scope.team || p.owner_team === scope.team);
  const pages = all.filter(inScope);
  const live = pages.filter((p) => !p.superseded_by);
  const mean = (ps: WikiPage[]) => (ps.length ? ps.reduce((s, p) => s + (1 - PENALTY[p.status]), 0) / ps.length : 1);

  // conflicts, scored with the conflict's own scope as context
  const conflicts: HealthReport['conflicts'] = [];
  for (const group of liveGroups(all).values()) {
    const first = group[0];
    if (!inScope(first) || new Set(group.map((g) => claimFor(g)!.value)).size < 2) continue;
    const ctx = { country: first.country ?? undefined, client: first.client ?? undefined };
    const topic = org.topic(first.topic) ?? { id: first.topic, label: first.topic, keywords: [] };
    const verdicts = scorePages(group.map((page) => ({ page, fromAssistant: false })), ctx, topic.id);
    for (const c of findConflicts(verdicts, topic, ctx) as Conflict[]) {
      conflicts.push({ ...c, id: conflictId(topic.id, first.country, first.client), open_task_id: openTaskFor(tasks, topic.id, first.country, first.client) });
    }
  }

  const issue = (p: WikiPage, detail: string): HealthIssuePage => ({
    page_id: p.id,
    title: p.title,
    owner: org.person(p.owner),
    owner_team: p.owner_team,
    country: p.country,
    detail,
    open_task_id: openTaskFor(tasks, p.topic, p.country, p.client, p.id),
  });

  const orphans = live.filter(isOrphan).map((p) => {
    const o = org.person(p.owner);
    return issue(p, o ? `Owner ${o.name} has left SD Worx` : `No owner since ${fmtDate(p.created)}`);
  });
  const stale = live
    .filter((p) => !isOrphan(p) && p.status === 'stale')
    .map((p) => issue(p, p.last_verified ? `Last verified ${fmtDate(p.last_verified)} (${ago(p.last_verified)})` : `Old ${p.source_type} from ${fmtDate(p.created)}`));
  const unverified = live
    .filter((p) => p.status === 'unverified')
    .map((p) =>
      issue(p, p.source_type === 'teams' || p.source_type === 'email' ? `Only in ${p.source_type === 'teams' ? 'a Teams chat' : 'an email'}` : `Edited ${ago(p.last_edited)}, never verified`),
    );
  const gaps = computeGaps(tasks).filter((g) => !scope.country || g.country === scope.country);

  const tiles: HealthTile[] = [];
  const tile = (key: string, kind: HealthTile['kind'], ps: WikiPage[]) =>
    tiles.push({ key, kind, score: Math.round(100 * mean(ps)), pages: ps.length, issues: ps.filter((p) => p.status !== 'verified').length });
  const teams = [...new Set(live.map((p) => p.owner_team ?? 'Unassigned'))].sort();
  for (const t of teams) tile(t, 'team', live.filter((p) => (p.owner_team ?? 'Unassigned') === t));
  const countries = [...new Set(live.map((p) => p.country ?? 'Cross-country'))].sort();
  for (const c of countries) tile(c, 'country', live.filter((p) => (p.country ?? 'Cross-country') === c));

  return {
    score: Math.max(0, Math.round(100 * mean(live)) - GAP_PENALTY * gaps.length),
    pages: live.length,
    verified: live.filter((p) => p.status === 'verified').length,
    tiles,
    conflicts,
    orphans,
    stale,
    unverified,
    gaps,
    open_tasks: tasks.filter((t) => t.status === 'open').length,
    generated_at: now().toISOString(),
  };
}
