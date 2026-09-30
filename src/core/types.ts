// TrustLayer shared contract. Core, MCP, API and dashboard all code against these types.

export type Country = 'BE' | 'NL';
export type SourceType = 'policy' | 'wiki' | 'email' | 'teams';
export type Origin = 'sharepoint' | 'teams' | 'outlook' | 'internal';
export type PageStatus = 'verified' | 'unverified' | 'conflict' | 'stale' | 'orphan' | 'superseded';

export interface Person {
  id: string;
  name: string;
  role: string;
  team: string;
  country: Country;
  active: boolean;
  email: string;
}

/** Who is accountable for a client in a country (from internal HR/CRM data). */
export interface Ownership {
  client: string;
  country: Country;
  domain: string; // e.g. "payroll"
  owner: string; // person id
  team: string;
  lead: string; // person id, fallback for orphaned pages
}

export interface Topic {
  id: string; // e.g. "sunday-overtime-premium"
  label: string;
  keywords: string[];
}

/** A structured claim extracted from a source (precomputed + cached in the vault, no LLM needed at runtime). */
export interface Claim {
  topic: string; // Topic.id
  value: string; // normalised comparable value, e.g. "120%"
  text: string; // the human sentence
  effective_from?: string; // ISO date, when the rule starts applying
}

/** A wiki page in vault/wiki/<id>.md. One page per knowledge item; `topic` groups pages about the same thing. */
export interface WikiPage {
  id: string;
  title: string;
  topic: string; // Topic.id
  owner: string | null; // person id
  owner_team: string | null;
  author: string | null; // person id of who wrote / last edited it
  country: Country | null;
  client: string | null;
  product: string | null;
  source_type: SourceType;
  origin: Origin;
  location: string; // where it lives today (mock URL)
  created: string; // ISO date
  last_edited: string; // ISO date
  last_verified: string | null; // ISO date
  status: PageStatus;
  sources: string[]; // raw SHA-256 hashes (vault/raw/<hash>.md)
  supersedes: string[]; // page ids this page replaces
  superseded_by?: string | null; // page id of the verified page that replaced this one
  captured_in?: string | null; // page id this chat/email was captured into
  claims: Claim[];
  body: string; // markdown body (without frontmatter)
}

/** A source as returned by some other assistant / retriever. Matched to a vault page by id, hash, location or title. */
export interface InputSource {
  id?: string;
  hash?: string;
  title?: string;
  location?: string;
  snippet?: string;
}

export interface QueryContext {
  country?: Country;
  client?: string;
  product?: string;
}

export interface TrustFactor {
  factor: 'ownership' | 'freshness' | 'scope' | 'authority' | 'corroboration' | 'supersession';
  points: number;
  reason: string;
}

export type Badge = 'good' | 'warn' | 'bad';

export interface SourceVerdict {
  page_id: string | null; // null = input source we could not match to the vault
  title: string;
  source_type: SourceType | null;
  origin: Origin | null;
  location: string | null;
  from_assistant: boolean; // true if it came in via verify_sources, false if TrustLayer added it
  score: number; // 0-100
  level: 'high' | 'medium' | 'low';
  claim: Claim | null;
  owner: Person | null;
  country: Country | null;
  last_verified: string | null;
  last_edited: string | null;
  status: PageStatus | 'unknown';
  flags: string[]; // short labels: "orphan", "unverified change", "scope mismatch", "stale", "verified", ...
  badges: { owner: Badge; freshness: Badge; scope: Badge; verified: Badge };
  factors: TrustFactor[];
  reasons: string[]; // human-readable, most important first
}

export interface ConflictSide {
  page_id: string;
  title: string;
  value: string;
  score: number;
  source_type: SourceType;
  owner_name: string | null;
  from_assistant: boolean;
}

/** Two or more in-scope sources making different claims about the same topic. */
export interface Conflict {
  id: string; // deterministic per topic + scope, e.g. "conflict-sunday-overtime-premium-be-nordwind-retail"
  topic: string;
  topic_label: string;
  country: Country | null;
  client: string | null;
  sides: ConflictSide[]; // sorted by score desc
  values: string[]; // distinct values, e.g. ["120%", "50%", "100%"]
  summary: string;
}

export interface Verdict {
  question: string;
  context: QueryContext; // resolved context (explicit + detected from the question)
  topic: Topic | null;
  sources: SourceVerdict[]; // sorted by score desc
  conflicts: Conflict[];
  recommended: SourceVerdict | null;
  answer: string; // one-line trusted answer
  answer_basis: string; // where the answer comes from + verification state, one line
  confidence: 'high' | 'medium' | 'low';
  verified: boolean; // true if the recommended source is an owner-verified page
  owner_to_ask: Person | null;
  owner_reason: string;
  actions: string[]; // recommended next steps
  open_task: Task | null; // open fix task for this topic + scope, if someone already flagged it
  generated_at: string;
}

export type IssueType = 'conflict' | 'orphan' | 'stale' | 'gap' | 'unverified' | 'capture';

export interface Task {
  id: string;
  topic: string; // Topic.id or page id
  topic_label: string;
  issue: IssueType;
  note: string;
  country: Country | null;
  client: string | null;
  page_ids: string[];
  assignee: string; // person id
  assignee_reason: string;
  suggested_claim: string | null; // what TrustLayer thinks the answer is
  status: 'open' | 'resolved';
  created_at: string;
  created_by: string;
  resolved_at: string | null;
  resolved_by: string | null;
  verified_claim: string | null;
  result_page_id: string | null;
}

export interface GapItem {
  question: string;
  topic: string | null;
  country: Country | null;
  client: string | null;
  times_asked: number;
  last_asked: string;
  best_score: number;
}

export interface HealthIssuePage {
  page_id: string;
  title: string;
  owner: Person | null;
  owner_team: string | null;
  country: Country | null;
  detail: string;
  open_task_id: string | null;
}

export interface HealthTile {
  key: string; // e.g. "Payroll BE – Retail" or "BE"
  kind: 'team' | 'country';
  score: number;
  pages: number;
  issues: number;
}

export interface HealthReport {
  score: number; // overall 0-100
  pages: number;
  verified: number;
  tiles: HealthTile[];
  conflicts: (Conflict & { open_task_id: string | null })[];
  orphans: HealthIssuePage[];
  stale: HealthIssuePage[];
  unverified: HealthIssuePage[];
  gaps: (GapItem & { open_task_id: string | null })[];
  open_tasks: number;
  generated_at: string;
}

export interface Expert {
  person: Person;
  reason: string;
  evidence: { page_id: string; title: string; date: string }[];
}

export interface QueryLogEntry {
  ts: string;
  question: string;
  topic: string | null;
  country: Country | null;
  client: string | null;
  best_score: number;
  asked_by: string;
}
