import fs from 'node:fs';
import path from 'node:path';
import type { Country, Ownership, Person, Topic } from './types';
import { MOCK_DIR, tokens } from './util';

// MOCK: people, teams, client ownership and topics come from fixture files in data/mock/internal.
interface TeamInfo {
  name: string;
  lead: string;
  country: Country;
}

export interface Org {
  people: Person[];
  teams: TeamInfo[];
  ownership: Ownership[];
  topics: Topic[];
  person(id: string | null | undefined): Person | null;
  accountable(client: string | null | undefined, country: Country | null | undefined): Ownership | null;
  teamLead(team: string | null | undefined): Person | null;
  topic(id: string | null | undefined): Topic | null;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(MOCK_DIR, 'internal', file), 'utf8')) as T;
}

let cached: Org | null = null;

export function loadOrg(): Org {
  if (cached) return cached;
  const { people, teams } = readJson<{ people: Person[]; teams: TeamInfo[] }>('people.json');
  const { ownership } = readJson<{ ownership: Ownership[] }>('ownership.json');
  const { topics } = readJson<{ topics: Topic[] }>('topics.json');
  const byId = new Map(people.map((p) => [p.id, p]));
  const norm = (s: string) => s.trim().toLowerCase();
  cached = {
    people,
    teams,
    ownership,
    topics,
    person: (id) => (id ? byId.get(id) ?? null : null),
    accountable: (client, country) =>
      client && country ? ownership.find((o) => norm(o.client) === norm(client) && o.country === country) ?? null : null,
    teamLead: (team) => {
      const t = teams.find((x) => x.name === team);
      return t ? byId.get(t.lead) ?? null : null;
    },
    topic: (id) => (id ? topics.find((t) => t.id === id) ?? null : null),
  };
  return cached;
}

const CLIENTS = [{ pattern: /nordwind/i, name: 'Nordwind Retail' }];

export function detectCountry(q: string): Country | undefined {
  if (/\b(belgium|belgian|belgië|belgie|belgique|flanders|brussels)\b/i.test(q) || /\bBE\b/.test(q)) return 'BE';
  if (/\b(netherlands|dutch|nederland|holland)\b/i.test(q) || /\bNL\b/.test(q)) return 'NL';
  return undefined;
}

export function detectClient(q: string): string | undefined {
  return CLIENTS.find((c) => c.pattern.test(q))?.name;
}

/** Deterministic topic detection: keyword overlap, first keywords of a topic are its most specific ones. */
export function detectTopic(q: string, org: Org = loadOrg()): Topic | null {
  const tk = new Set(tokens(q));
  let best: Topic | null = null;
  let bestScore = 0;
  for (const t of org.topics) {
    let s = 0;
    t.keywords.forEach((k, i) => {
      if (tk.has(k)) s += i < 2 ? 2 : 1;
    });
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return bestScore >= 2 ? best : null;
}
