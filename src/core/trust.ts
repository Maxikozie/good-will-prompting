import type {
  Badge,
  Conflict,
  InputSource,
  Person,
  QueryContext,
  SourceVerdict,
  Topic,
  TrustFactor,
  Verdict,
  WikiPage,
} from './types';
import { detectClient, detectCountry, detectTopic, loadOrg, type Org } from './org';
import { COUNTRY_NAMES, ago, daysSince, fmtDate, now, slug, tokens, STALE_DAYS } from './util';
import { appendQuery, listPages, loadTasks } from './vault';

// Deterministic, explainable trust scoring. No LLM involved: every point has a human-readable reason.
//   ownership   0-30  accountable owner > owner in the client's team > any owner > left company > none
//   freshness   0-25  recently verified > verified this year > chat from this month > never verified / stale
//   scope       0-25  country + client match; a mismatch caps the whole score at 20
//   authority   4-15  policy doc > team wiki > email > Teams chat
//   corroboration  +5 per agreeing in-scope source (max +10), -15 if contradicted by a more trusted one
//   supersession   replaced by a verified page caps the score at 10

const AUTHORITY: Record<string, { points: number; reason: string }> = {
  policy: { points: 15, reason: 'Owned policy document' },
  wiki: { points: 10, reason: 'Team wiki page' },
  email: { points: 6, reason: 'Email: not a maintained document' },
  teams: { points: 4, reason: 'Teams chat: not a maintained document' },
};

const FACTOR_MAX: Record<string, number> = { ownership: 30, freshness: 25, scope: 25, authority: 15, corroboration: 10, supersession: 10 };
const SCOPE_CAP = 20;
const SUPERSEDED_CAP = 10;

export function resolveContext(question: string, ctx: QueryContext = {}): QueryContext {
  return {
    country: ctx.country ?? detectCountry(question),
    client: ctx.client ?? detectClient(question),
    product: ctx.product,
  };
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

export function inScope(page: WikiPage, ctx: QueryContext): boolean {
  if (ctx.country && page.country && page.country !== ctx.country) return false;
  if (ctx.client && page.client && !same(page.client, ctx.client)) return false;
  return true;
}

interface Scored {
  page: WikiPage | null;
  input: InputSource | null;
  fromAssistant: boolean;
  factors: TrustFactor[];
  flags: Set<string>;
  badges: SourceVerdict['badges'];
  caps: { max: number; reason: string }[];
  base: number;
  mismatch: boolean;
}

function scoreBase(page: WikiPage, ctx: QueryContext, org: Org, pagesById: Map<string, WikiPage>): Scored {
  const factors: TrustFactor[] = [];
  const flags = new Set<string>();
  const caps: Scored['caps'] = [];
  const badges: SourceVerdict['badges'] = { owner: 'bad', freshness: 'bad', scope: 'warn', verified: 'warn' };
  const isChat = page.source_type === 'teams' || page.source_type === 'email';

  // --- ownership
  const owner = org.person(page.owner);
  const acc = org.accountable(page.client, page.country);
  const lead = org.teamLead(page.owner_team);
  if (!owner) {
    factors.push({ factor: 'ownership', points: 0, reason: 'No owner: nobody is accountable for this document (orphan)' });
    flags.add('orphan');
  } else if (!owner.active) {
    factors.push({ factor: 'ownership', points: 3, reason: `Owner ${owner.name} has left SD Worx: effectively orphaned` });
    flags.add('orphan');
  } else if (acc?.owner === owner.id) {
    const verb = isChat ? 'Written by' : 'Owned by';
    factors.push({ factor: 'ownership', points: 30, reason: `${verb} ${owner.name}, accountable ${acc.domain} owner for ${acc.client} ${acc.country}` });
    badges.owner = 'good';
  } else if (lead?.id === owner.id) {
    factors.push({ factor: 'ownership', points: 30, reason: `Owned by ${owner.name}, ${owner.role} of ${page.owner_team}` });
    badges.owner = 'good';
  } else if (acc && owner.team === acc.team) {
    factors.push({ factor: 'ownership', points: 25, reason: `Owned by ${owner.name} (${owner.team}), the client's payroll team` });
    badges.owner = 'good';
  } else {
    const suffix = acc ? `, not the client's ${acc.domain} team` : '';
    factors.push({ factor: 'ownership', points: 18, reason: `Owned by ${owner.name} (${owner.team})${suffix}` });
    badges.owner = 'warn';
  }

  // --- freshness
  if (page.last_verified) {
    const d = daysSince(page.last_verified);
    const editedAfter = !!page.last_edited && page.last_edited > page.last_verified;
    if (editedAfter) {
      factors.push({ factor: 'freshness', points: 8, reason: `Unverified change: edited ${ago(page.last_edited)}, after its last verification (${fmtDate(page.last_verified)})` });
      flags.add('unverified change');
      badges.freshness = 'warn';
    } else if (d <= 90) {
      factors.push({ factor: 'freshness', points: 25, reason: `Verified ${ago(page.last_verified)} (${fmtDate(page.last_verified)})` });
      badges.freshness = 'good';
      badges.verified = 'good';
      flags.add('verified');
    } else if (d <= STALE_DAYS) {
      factors.push({ factor: 'freshness', points: 15, reason: `Verified ${ago(page.last_verified)} (${fmtDate(page.last_verified)})` });
      badges.freshness = 'good';
      badges.verified = 'good';
      flags.add('verified');
    } else {
      factors.push({ factor: 'freshness', points: 3, reason: `Stale: last verified ${ago(page.last_verified)} (${fmtDate(page.last_verified)})` });
      flags.add('stale');
      badges.verified = 'bad';
    }
  } else if (isChat) {
    const d = daysSince(page.last_edited);
    const where = page.source_type === 'teams' ? 'Teams chat' : 'an email';
    if (page.captured_in) {
      const into = pagesById.get(page.captured_in);
      factors.push({ factor: 'freshness', points: 18, reason: `Posted ${ago(page.created)}; captured into "${into?.title ?? page.captured_in}"` });
      badges.freshness = 'good';
    } else if (d <= 30) {
      factors.push({ factor: 'freshness', points: 18, reason: `Posted ${ago(page.created)} (${fmtDate(page.created)}), but it only lives in ${where}` });
      flags.add(page.source_type === 'teams' ? 'only in chat' : 'only in email');
      badges.freshness = 'good';
    } else if (d <= STALE_DAYS) {
      factors.push({ factor: 'freshness', points: 10, reason: `Sent ${ago(page.created)}, never turned into a document` });
      badges.freshness = 'warn';
    } else {
      factors.push({ factor: 'freshness', points: 2, reason: `Old message (${fmtDate(page.created)}), never turned into a document` });
      flags.add('stale');
      badges.verified = 'bad';
    }
  } else {
    const d = daysSince(page.last_edited);
    const editor = org.person(page.author);
    if (d <= 30) {
      factors.push({ factor: 'freshness', points: 5, reason: `Unverified change: edited ${ago(page.last_edited)}${editor ? ` by ${editor.name}` : ''}, never verified by an owner` });
      flags.add('unverified change');
      badges.freshness = 'warn';
    } else {
      factors.push({ factor: 'freshness', points: 3, reason: `Never verified; last touched ${fmtDate(page.last_edited)} (${ago(page.last_edited)})` });
      flags.add('never verified');
      badges.verified = 'bad';
    }
  }

  // --- scope
  let scopePts = 0;
  const scopeReasons: string[] = [];
  const mismatchReasons: string[] = [];
  let mismatch = false;
  if (ctx.country) {
    if (page.country && page.country !== ctx.country) {
      mismatch = true;
      mismatchReasons.push(`Applies to ${page.country}, you asked about ${ctx.country}`);
    } else if (page.country) {
      scopePts += 15;
      scopeReasons.push(`Covers ${COUNTRY_NAMES[page.country]}`);
    } else {
      scopePts += 8;
      scopeReasons.push('Not country-specific');
    }
  } else {
    scopePts += 8;
    scopeReasons.push('No country given, scope not checked');
  }
  if (ctx.client) {
    if (page.client && !same(page.client, ctx.client)) {
      mismatch = true;
      mismatchReasons.push(`About ${page.client}, you asked about ${ctx.client}`);
    } else if (page.client) {
      scopePts += 10;
      scopeReasons.push(`specific to ${page.client}`);
    } else {
      scopePts += 3;
      scopeReasons.push('generic, not client-specific');
    }
  } else {
    scopePts += 5;
  }
  if (mismatch) {
    const reason = `Scope mismatch: ${mismatchReasons.join('; ')}`;
    factors.push({ factor: 'scope', points: 0, reason });
    caps.push({ max: SCOPE_CAP, reason });
    flags.add('scope mismatch');
    badges.scope = 'bad';
  } else {
    factors.push({ factor: 'scope', points: scopePts, reason: scopeReasons.join(', ') });
    badges.scope = ctx.country && page.country === ctx.country ? 'good' : 'warn';
  }

  // --- authority
  const auth = AUTHORITY[page.source_type] ?? AUTHORITY.wiki;
  const authReason = page.origin === 'internal' ? 'Owner-verified TrustLayer wiki page' : auth.reason;
  factors.push({ factor: 'authority', points: auth.points, reason: authReason });

  // --- supersession
  if (page.superseded_by) {
    const by = pagesById.get(page.superseded_by);
    const who = org.person(by?.owner);
    caps.push({
      max: SUPERSEDED_CAP,
      reason: `Superseded by "${by?.title ?? page.superseded_by}"${who ? `, verified by ${who.name}` : ''} on ${fmtDate(by?.last_verified)}`,
    });
    flags.add('superseded');
    badges.verified = 'bad';
    flags.delete('verified');
  }

  const base = factors.reduce((s, f) => s + f.points, 0);
  return { page, input: null, fromAssistant: false, factors, flags, badges, caps, base, mismatch };
}

function level(score: number): SourceVerdict['level'] {
  return score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
}

function toVerdict(s: Scored, topicId: string | null, org: Org): SourceVerdict {
  let score = Math.max(0, Math.min(100, s.factors.reduce((sum, f) => sum + f.points, 0)));
  for (const c of s.caps) score = Math.min(score, c.max);
  const p = s.page;
  const claim = p ? p.claims.find((c) => c.topic === topicId) ?? p.claims[0] ?? null : null;
  // Explain the verdict: trusted sources lead with their strengths, weak ones with their problems.
  const ratio = (f: TrustFactor) => f.points / (FACTOR_MAX[f.factor] ?? 10);
  const concerns = s.factors.filter((f) => ratio(f) < 0.4).sort((a, b) => ratio(a) - ratio(b));
  const strengths = s.factors.filter((f) => ratio(f) >= 0.4).sort((a, b) => b.points - a.points);
  const ordered = score >= 70 ? [...strengths, ...concerns] : [...concerns, ...strengths];
  const reasons = [...s.caps.map((c) => c.reason), ...ordered.map((f) => f.reason)].filter((r, i, arr) => arr.indexOf(r) === i);
  return {
    page_id: p?.id ?? null,
    title: p?.title ?? s.input?.title ?? s.input?.id ?? 'Unknown source',
    source_type: p?.source_type ?? null,
    origin: p?.origin ?? null,
    location: p?.location ?? s.input?.location ?? null,
    from_assistant: s.fromAssistant,
    score,
    level: level(score),
    claim,
    owner: p ? org.person(p.owner) : null,
    country: p?.country ?? null,
    last_verified: p?.last_verified ?? null,
    last_edited: p?.last_edited ?? null,
    status: p?.status ?? 'unknown',
    flags: [...s.flags],
    badges: s.badges,
    factors: s.factors,
    reasons,
  };
}

function unknownSource(input: InputSource): Scored {
  return {
    page: null,
    input,
    fromAssistant: true,
    factors: [{ factor: 'ownership', points: 5, reason: 'Not in the TrustLayer vault: no owner, date or scope metadata to check' }],
    flags: new Set(['unknown source']),
    badges: { owner: 'bad', freshness: 'bad', scope: 'warn', verified: 'bad' } as Record<string, Badge> as SourceVerdict['badges'],
    caps: [],
    base: 5,
    mismatch: false,
  };
}

/** Corroboration pass: agreeing in-scope sources reinforce each other, a more trusted contradiction costs points. */
function corroborate(scored: Scored[], topicId: string | null): void {
  const claimOf = (s: Scored) => (s.page && topicId ? s.page.claims.find((c) => c.topic === topicId) : undefined);
  const live = scored.filter((s) => s.page && !s.mismatch && !s.page.superseded_by && claimOf(s));
  for (const s of live) {
    const mine = claimOf(s)!;
    const agree = live.filter((o) => o !== s && claimOf(o)!.value === mine.value);
    const disagree = live.filter((o) => o !== s && claimOf(o)!.value !== mine.value);
    if (agree.length) {
      s.factors.push({
        factor: 'corroboration',
        points: Math.min(10, 5 * agree.length),
        reason: `Corroborated by ${agree.map((o) => `"${o.page!.title}"`).join(', ')}`,
      });
      s.flags.add('corroborated');
    }
    const stronger = disagree.filter((o) => o.base > s.base).sort((a, b) => b.base - a.base);
    if (stronger.length) {
      const top = stronger[0];
      const topClaim = claimOf(top)!;
      const newer = topClaim.effective_from && (!mine.effective_from || topClaim.effective_from > mine.effective_from);
      s.factors.push({
        factor: 'corroboration',
        points: -15,
        reason: newer
          ? `Outdated: "${top.page!.title}" says ${topClaim.value} under a rule effective from ${fmtDate(topClaim.effective_from)}`
          : `Contradicted by "${top.page!.title}" (${topClaim.value}), a more trusted source`,
      });
      s.flags.add('contradicted');
    } else if (disagree.length) {
      s.factors.push({
        factor: 'corroboration',
        points: 0,
        reason: `Disagrees with ${disagree.length} less trusted source${disagree.length > 1 ? 's' : ''}`,
      });
    }
  }
}

export function scorePages(
  entries: { page: WikiPage; fromAssistant: boolean }[],
  ctx: QueryContext,
  topicId: string | null,
  extra: InputSource[] = [],
): SourceVerdict[] {
  const org = loadOrg();
  const pagesById = new Map(listPages().map((p) => [p.id, p]));
  const scored = entries.map((e) => ({ ...scoreBase(e.page, ctx, org, pagesById), fromAssistant: e.fromAssistant }));
  corroborate(scored, topicId);
  return [...scored, ...extra.map(unknownSource)]
    .map((s) => toVerdict(s, topicId, org))
    .sort((a, b) => b.score - a.score || Number(b.from_assistant) - Number(a.from_assistant));
}

export function conflictId(topic: string, country: string | null | undefined, client: string | null | undefined): string {
  return `conflict-${slug([topic, country ?? 'all', client ?? 'all'].join('-'))}`;
}

/** Two or more in-scope, non-superseded sources claiming different values for the same topic. */
export function findConflicts(verdicts: SourceVerdict[], topic: Topic | null, ctx: QueryContext): Conflict[] {
  if (!topic) return [];
  const live = verdicts.filter(
    (v) => v.page_id && v.claim && v.claim.topic === topic.id && !v.flags.includes('scope mismatch') && !v.flags.includes('superseded'),
  );
  const values = [...new Set(live.map((v) => v.claim!.value))];
  if (values.length < 2) return [];
  const sides = live.map((v) => ({
    page_id: v.page_id!,
    title: v.title,
    value: v.claim!.value,
    score: v.score,
    source_type: v.source_type!,
    owner_name: v.owner?.name ?? null,
    from_assistant: v.from_assistant,
  }));
  const scope = [ctx.client, ctx.country].filter(Boolean).join(' ');
  return [
    {
      id: conflictId(topic.id, ctx.country, ctx.client),
      topic: topic.id,
      topic_label: topic.label,
      country: ctx.country ?? null,
      client: ctx.client ?? null,
      sides,
      values,
      summary: `${sides.length} in-scope sources disagree on ${topic.label.toLowerCase()}${scope ? ` (${scope})` : ''}: ${sides.map((s) => s.value).join(' vs ')}`,
    },
  ];
}

function matchInput(input: InputSource, pages: WikiPage[]): WikiPage | null {
  const norm = (s: string) => s.trim().toLowerCase();
  return (
    (input.id && pages.find((p) => p.id === input.id)) ||
    (input.hash && pages.find((p) => p.sources.includes(input.hash!))) ||
    (input.location && pages.find((p) => p.location && norm(p.location) === norm(input.location!))) ||
    (input.title && pages.find((p) => norm(p.title) === norm(input.title!))) ||
    null
  );
}

function keywordSearch(question: string, pages: WikiPage[], n: number): WikiPage[] {
  const q = new Set(tokens(question).filter((t) => t.length > 3));
  return pages
    .filter((p) => !p.superseded_by)
    .map((p) => ({ p, s: tokens(`${p.title} ${p.body}`).filter((t) => q.has(t)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map((x) => x.p);
}

function firstName(p: Person | null): string {
  return p?.name.split(' ')[0] ?? 'the owner';
}

export interface VerdictOptions {
  sources?: InputSource[]; // what another assistant returned (verify_sources); omit for trusted_answer
  log?: boolean;
  askedBy?: string;
}

/** The trust verdict. Used by both verify_sources (with sources) and trusted_answer (vault search only). */
export function buildVerdict(question: string, ctxIn: QueryContext = {}, opts: VerdictOptions = {}): Verdict {
  const org = loadOrg();
  const pages = listPages();
  const ctx = resolveContext(question, ctxIn);
  const topic = detectTopic(question, org);

  const entries = new Map<string, { page: WikiPage; fromAssistant: boolean }>();
  const unknown: InputSource[] = [];
  for (const input of opts.sources ?? []) {
    const p = matchInput(input, pages);
    if (p) entries.set(p.id, { page: p, fromAssistant: true });
    else unknown.push(input);
  }
  // TrustLayer adds what the other assistant missed: every in-scope, live page on the same topic.
  if (topic) {
    for (const p of pages) {
      if (p.topic === topic.id && !p.superseded_by && inScope(p, ctx) && !entries.has(p.id)) {
        entries.set(p.id, { page: p, fromAssistant: false });
      }
    }
  } else if (!opts.sources?.length) {
    for (const p of keywordSearch(question, pages, 3)) entries.set(p.id, { page: p, fromAssistant: false });
  }

  const sources = scorePages([...entries.values()], ctx, topic?.id ?? null, unknown);
  const conflicts = findConflicts(sources, topic, ctx);
  const recommended = sources.find((s) => s.page_id && s.claim && s.score >= 40 && !s.flags.includes('scope mismatch')) ?? null;
  const recPage = recommended ? entries.get(recommended.page_id!)?.page ?? null : null;
  const isChat = recPage?.source_type === 'teams' || recPage?.source_type === 'email';
  const verified = !!recommended && recommended.flags.includes('verified') && !isChat;

  const acc = org.accountable(ctx.client, ctx.country);
  const owner_to_ask = acc ? org.person(acc.owner) : recommended?.owner ?? null;
  const owner_reason = acc
    ? `Accountable ${acc.domain} owner for ${acc.client} ${acc.country} (${acc.team})`
    : recommended?.owner
      ? 'Owner of the recommended source'
      : 'No accountable owner found for this scope';

  const confidence: Verdict['confidence'] =
    verified && !conflicts.length ? 'high' : recommended && recommended.score >= 70 ? 'medium' : 'low';

  let answer = 'No trustworthy answer in the knowledge base yet.';
  let answer_basis = owner_to_ask ? `Ask ${owner_to_ask.name} (${owner_reason}).` : 'Flag this as a knowledge gap.';
  if (recommended?.claim) {
    answer = recommended.claim.text;
    const who = recommended.owner?.name ?? 'unknown owner';
    if (verified) answer_basis = `Verified by ${who} on ${fmtDate(recommended.last_verified)} · "${recommended.title}"`;
    else if (isChat)
      answer_basis = `${who} in ${recPage!.source_type === 'teams' ? 'Teams' : 'an email'} on ${fmtDate(recPage!.created)} · not yet in a verified document`;
    else answer_basis = `"${recommended.title}" (${who}) · not verified`;
  }

  const actions: string[] = [];
  if (verified && !conflicts.length) actions.push(`Safe to answer: verified by ${recommended!.owner?.name ?? 'the owner'} on ${fmtDate(recommended!.last_verified)}.`);
  if (conflicts.length && owner_to_ask)
    actions.push(`Flag the conflict to ${owner_to_ask.name}: ${conflicts[0].sides.length} sources disagree (${conflicts[0].values.join(' vs ')}).`);
  if (recommended && isChat && !recPage?.captured_in)
    actions.push(`Capture ${firstName(recommended.owner)}'s ${recPage!.source_type === 'teams' ? 'Teams message' : 'email'} into the wiki so the next colleague finds it.`);
  for (const s of sources) {
    const p = s.page_id ? entries.get(s.page_id)?.page : null;
    if (!p || s.flags.includes('superseded')) continue;
    if (s.flags.includes('scope mismatch') && s.from_assistant) actions.push(`Ignore "${s.title}": it applies to ${p.country ?? p.client}, not ${ctx.country ?? ctx.client}.`);
    else if (s.flags.includes('orphan')) actions.push(`"${s.title}" has no active owner: assign it to ${org.teamLead(p.owner_team)?.name ?? 'a team lead'} or archive it.`);
    else if (s.flags.includes('unverified change') && s !== recommended) actions.push(`"${s.title}" changed ${ago(p.last_edited)} without verification: ask ${firstName(owner_to_ask)} to verify or revert it.`);
  }
  if (!recommended) actions.push(owner_to_ask ? `Ask ${owner_to_ask.name} and capture the answer: this is a knowledge gap.` : 'Flag this as a knowledge gap.');

  const open_task =
    loadTasks().find(
      (t) => t.status === 'open' && topic && t.topic === topic.id && (t.country ?? undefined) === ctx.country && same(t.client ?? '', ctx.client ?? ''),
    ) ?? null;

  if (opts.log !== false) {
    try {
      appendQuery({
        ts: now().toISOString(),
        question: question.slice(0, 500),
        topic: topic?.id ?? null,
        country: ctx.country ?? null,
        client: ctx.client ?? null,
        best_score: recommended?.score ?? 0,
        asked_by: opts.askedBy ?? 'unknown',
      });
    } catch {
      // logging must never break an answer
    }
  }

  return {
    question,
    context: ctx,
    topic,
    sources,
    conflicts,
    recommended,
    answer,
    answer_basis,
    confidence,
    verified,
    owner_to_ask,
    owner_reason,
    actions,
    open_task,
    generated_at: now().toISOString(),
  };
}
