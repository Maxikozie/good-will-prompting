import type { Expert, QueryContext } from './types';
import { loadOrg } from './org';
import { detectTopic } from './org';
import { resolveContext, scorePages, inScope } from './trust';
import { listPages } from './vault';

// Connect: who owns / last answered this? Documents are not always enough.

export function findExpert(topicOrQuestion: string, ctxIn: QueryContext = {}): { topic: string | null; experts: Expert[]; note: string | null } {
  const org = loadOrg();
  const topic = org.topic(topicOrQuestion) ?? detectTopic(topicOrQuestion, org);
  const ctx = resolveContext(topicOrQuestion, ctxIn);
  const found = new Map<string, { score: number; reasons: string[]; evidence: Expert['evidence'] }>();
  const add = (id: string | null, score: number, reason: string, ev?: Expert['evidence'][number]) => {
    const p = org.person(id);
    if (!p || !p.active) return;
    const e = found.get(p.id) ?? { score: 0, reasons: [], evidence: [] };
    e.score += score;
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
    if (ev && !e.evidence.some((x) => x.page_id === ev.page_id)) e.evidence.push(ev);
    found.set(p.id, e);
  };

  const acc = org.accountable(ctx.client, ctx.country);
  if (acc) add(acc.owner, 100, `Accountable ${acc.domain} owner for ${acc.client} ${acc.country}`);

  let note: string | null = null;
  if (topic) {
    const pages = listPages().filter((p) => p.topic === topic.id && inScope(p, ctx));
    const scored = scorePages(pages.map((page) => ({ page, fromAssistant: false })), ctx, topic.id);
    for (const v of scored) {
      const page = pages.find((p) => p.id === v.page_id);
      if (!page || v.flags.includes('scope mismatch')) continue;
      const ev = { page_id: page.id, title: page.title, date: page.last_verified ?? page.last_edited };
      if (page.source_type === 'teams' || page.source_type === 'email') {
        add(page.author, v.score / 2, `Last answered this in ${page.source_type === 'teams' ? 'Teams' : 'an email'} (${page.created})`, ev);
      } else {
        add(page.owner, v.score / 2, `Owns "${page.title}"`, ev);
      }
      const owner = org.person(page.owner);
      if (owner && !owner.active) note = `${owner.name} used to own "${page.title}" but has left SD Worx.`;
    }
  }
  if (!found.size) {
    const lead = org.teamLead(acc?.team ?? org.teams.find((t) => t.country === ctx.country)?.name);
    if (lead) add(lead.id, 10, `Team lead of ${lead.team}`);
  }

  const experts = [...found.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 3)
    .map(([id, e]) => ({ person: org.person(id)!, reason: e.reasons.join('; '), evidence: e.evidence }));
  return { topic: topic?.id ?? null, experts, note };
}
