import { ClaimsFileSchema, SharePointSchema, TeamsSchema, EmailSchema, QueriesSeedSchema } from './input-schemas';
import { readJson, readText, parseJson, boundText, isSafeFileName, resolveInside } from '../../packages/brain/src/security/input';
import fs from 'node:fs';
import path from 'node:path';
import type { Claim, Country, Origin, QueryLogEntry, SourceType, WikiPage } from './types';
import { detectClient, detectCountry, detectTopic, loadOrg } from './org';
import { COUNTRY_NAMES, MOCK_DIR, fmtDate, sha256 } from './util';
import { appendQuery, ensureVaultDirs, putRaw, resetMeta, savePage, saveTasks, splitFrontmatter } from './vault';

// Ingest = turn scattered sources (SharePoint, Teams, Outlook) into the markdown brain.
// MOCK: sources are fixture files in data/mock; real connectors would be Microsoft Graph.

const ORIGIN_LABEL: Record<Origin, string> = {
  sharepoint: 'SharePoint',
  teams: 'Microsoft Teams',
  outlook: 'Outlook email',
  internal: 'TrustLayer wiki',
};

function files(dir: string, ext: string): string[] {
  const full = resolveInside(MOCK_DIR, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((f) => isSafeFileName(f, ext))
    .sort()
    .map((f) => resolveInside(full, f));
}

function loadClaims(): Record<string, Claim[]> {
  const f = resolveInside(MOCK_DIR, 'claims-cache.json');
  return readJson(f, ClaimsFileSchema).claims;
}

function date(iso: string | null | undefined): string {
  return iso ? String(iso).slice(0, 10) : '';
}

export function renderBody(page: Omit<WikiPage, 'body'>, content: string): string {
  const org = loadOrg();
  const owner = org.person(page.owner);
  const topicLabel = (id: string) => org.topic(id)?.label ?? id;
  const lines = [
    `# ${page.title}`,
    '',
    `> **${ORIGIN_LABEL[page.origin]}** · owner: ${owner ? `[[${owner.name}]]` : '**none (orphan)**'} · ` +
      `country: ${page.country ? COUNTRY_NAMES[page.country] : 'all'} · client: ${page.client ?? 'all'} · ` +
      `last verified: ${fmtDate(page.last_verified)}`,
    `> Lives at: ${page.location}`,
    '',
    '## Claims',
    ...(page.claims.length
      ? page.claims.map((c) => `- **${topicLabel(c.topic)}: ${c.value}**: ${c.text} [^1]`)
      : ['- _No structured claims extracted._']),
    '',
    '## Source content',
    '',
    content.trim(),
    '',
    ...page.sources.map((h, i) => `[^${i + 1}]: raw/${h} (immutable copy, SHA-256)`),
  ];
  return lines.join('\n');
}

function ingestSharePoint(file: string, claims: Record<string, Claim[]>, ingestedAt: string): WikiPage {
  const raw = boundText(readText(file));
  const hash = sha256(raw);
  const { data: metadata, body } = splitFrontmatter(raw);
  const data = SharePointSchema.parse(metadata);
  const id = String(data.id);
  putRaw(hash, raw, { source_id: id, origin: 'sharepoint', original: path.relative(MOCK_DIR, file).replace(/\\/g, '/'), ingested_at: ingestedAt, ext: 'md' });
  const c = claims[id] ?? [];
  const page: Omit<WikiPage, 'body'> = {
    id,
    title: String(data.title),
    topic: c[0]?.topic ?? 'misc',
    owner: (data.owner as string | null) ?? null,
    owner_team: (data.owner_team as string | null) ?? null,
    author: ((data.modified_by ?? data.created_by) as string | null) ?? null,
    country: (data.country as Country | null) ?? null,
    client: (data.client as string | null) ?? null,
    product: (data.product as string | null) ?? null,
    source_type: (data.content_type as SourceType) ?? 'wiki',
    origin: 'sharepoint',
    location: String(data.url),
    created: date(data.created as string),
    last_edited: date(data.modified as string),
    last_verified: data.last_verified ? date(data.last_verified as string) : null,
    status: 'unverified',
    sources: [hash],
    supersedes: [],
    superseded_by: null,
    captured_in: null,
    claims: c,
  };
  return { ...page, body: renderBody(page, body) };
}

function ingestTeams(file: string, claims: Record<string, Claim[]>, ingestedAt: string): WikiPage {
  const org = loadOrg();
  const raw = boundText(readText(file));
  const hash = sha256(raw);
  const t = TeamsSchema.parse(parseJson(raw));
  putRaw(hash, raw, { source_id: t.id, origin: 'teams', original: path.relative(MOCK_DIR, file).replace(/\\/g, '/'), ingested_at: ingestedAt, ext: 'json' });
  const root = t.messages[0];
  const last = t.messages[t.messages.length - 1];
  const c = claims[t.id] ?? [];
  const transcript = t.messages
    .map((m) => `**${org.person(m.from)?.name ?? m.from}** (${fmtDate(m.createdDateTime)}): ${m.body}`)
    .join('\n\n');
  const page: Omit<WikiPage, 'body'> = {
    id: t.id,
    title: t.title,
    topic: c[0]?.topic ?? 'misc',
    owner: root.from,
    owner_team: t.team,
    author: root.from,
    country: t.country,
    client: t.client,
    product: t.product,
    source_type: 'teams',
    origin: 'teams',
    location: t.url,
    created: date(root.createdDateTime),
    last_edited: date(last.createdDateTime),
    last_verified: null,
    status: 'unverified',
    sources: [hash],
    supersedes: [],
    superseded_by: null,
    captured_in: null,
    claims: c,
  };
  return { ...page, body: renderBody(page, `Channel: ${t.team} › ${t.channel}\n\n${transcript}`) };
}

function ingestEmail(file: string, claims: Record<string, Claim[]>, ingestedAt: string): WikiPage {
  const org = loadOrg();
  const raw = boundText(readText(file));
  const hash = sha256(raw);
  const e = EmailSchema.parse(parseJson(raw));
  putRaw(hash, raw, { source_id: e.id, origin: 'outlook', original: path.relative(MOCK_DIR, file).replace(/\\/g, '/'), ingested_at: ingestedAt, ext: 'json' });
  const c = claims[e.id] ?? [];
  const sender = org.person(e.from);
  const page: Omit<WikiPage, 'body'> = {
    id: e.id,
    title: `Email – ${e.subject}`,
    topic: c[0]?.topic ?? 'misc',
    owner: e.from,
    owner_team: sender?.team ?? null,
    author: e.from,
    country: e.country,
    client: e.client,
    product: e.product,
    source_type: 'email',
    origin: 'outlook',
    location: e.url,
    created: date(e.sentDateTime),
    last_edited: date(e.sentDateTime),
    last_verified: null,
    status: 'unverified',
    sources: [hash],
    supersedes: [],
    superseded_by: null,
    captured_in: null,
    claims: c,
  };
  const content = `From: ${sender?.name ?? e.from} · To: ${e.to.join(', ')} · Sent: ${fmtDate(e.sentDateTime)}\n\n${e.body}`;
  return { ...page, body: renderBody(page, content) };
}

/** Rebuild the wiki + meta from data/mock. Raw copies are content-addressed and never overwritten. */
export function ingest(): { pages: number } {
  ensureVaultDirs();
  resetMeta();
  const claims = loadClaims();
  const ingestedAt = new Date().toISOString();
  const pages: WikiPage[] = [
    ...files('sharepoint', '.md').map((f) => ingestSharePoint(f, claims, ingestedAt)),
    ...files('teams', '.json').map((f) => ingestTeams(f, claims, ingestedAt)),
    ...files('email', '.json').map((f) => ingestEmail(f, claims, ingestedAt)),
  ];
  for (const p of pages) savePage(p);
  saveTasks([]);

  // MOCK: seed the query log with questions colleagues asked this month.
  const seed = readJson(resolveInside(MOCK_DIR, 'internal', 'queries-seed.json'), QueriesSeedSchema);
  for (const q of seed.queries) {
    const entry: QueryLogEntry = {
      ts: q.ts,
      question: q.question,
      topic: detectTopic(q.question)?.id ?? null,
      country: detectCountry(q.question) ?? null,
      client: detectClient(q.question) ?? null,
      best_score: -1, // recomputed live by the health radar
      asked_by: q.asked_by,
    };
    appendQuery(entry);
  }
  return { pages: pages.length };
}
