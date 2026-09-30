import { LIMITS } from '../../packages/brain/src/security/limits';
import { boundText } from '../../packages/brain/src/security/input';
import { parseEnv } from '../../packages/brain/src/security/env';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root, independent of the cwd (Claude Desktop may start the MCP server from anywhere).
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Config comes from .env only (gitignored). Empty values count as unset.
const ENV_FILE = path.join(ROOT, '.env');
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
for (const k of ['PORT', 'HOST', 'TRUSTLAYER_NOW', 'TRUSTLAYER_VAULT_DIR']) if (process.env[k] === '') delete process.env[k];
export const ENV = parseEnv();
export const MOCK_DIR = path.join(ROOT, 'data', 'mock');
// Operator-set only (env), never from a request. Lets you run a scratch vault for rehearsals.
export const VAULT_DIR = ENV.TRUSTLAYER_VAULT_DIR ? path.resolve(ENV.TRUSTLAYER_VAULT_DIR) : path.join(ROOT, 'vault');
export const RAW_DIR = path.join(VAULT_DIR, 'raw');
export const WIKI_DIR = path.join(VAULT_DIR, 'wiki');
export const META_DIR = path.join(VAULT_DIR, '.meta');

// Only ids matching these patterns are ever turned into file paths (no user-supplied paths, no traversal).
export const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const HASH_RE = /^[a-f0-9]{64}$/;
export const TASK_ID_RE = /^task-[a-z0-9-]{1,60}$/;
export const PERSON_ID_RE = /^[a-z0-9][a-z0-9.-]{0,60}$/;

export const TRUST_THRESHOLD = 60;
export const STALE_DAYS = 365;
const DAY = 86_400_000;

/** Current time. TRUSTLAYER_NOW (ISO date) pins it for replaying the demo on another day. */
export function now(): Date {
  const pinned = parseEnv().TRUSTLAYER_NOW;
  if (pinned) {
    const d = new Date(pinned);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function today(): string {
  return now().toISOString().slice(0, 10);
}

export function daysSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, Math.floor((now().getTime() - t) / DAY));
}

export function ago(iso: string | null | undefined): string {
  const d = daysSince(iso);
  if (!Number.isFinite(d)) return 'never';
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  if (d < 365) return `${Math.round(d / 30)} months ago`;
  const y = Math.floor(d / 365);
  return `${y} year${y > 1 ? 's' : ''} ago`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9à-ÿ%€-]+/)
    .filter(Boolean);
}

export const COUNTRY_NAMES: Record<string, string> = { BE: 'Belgium', NL: 'the Netherlands' };

/** Pull a comparable value out of a free-text claim: "120%", "€8.00", or a short normalised phrase. */
export function extractValue(text: string): string {
  boundText(text, LIMITS.claimChars);
  const pct = text.match(/(\d+(?:[.,]\d+)?)\s?%/);
  if (pct) return `${pct[1].replace(',', '.')}%`;
  const eur = text.match(/€\s?(\d+(?:[.,]\d{1,2})?)/);
  if (eur) return `€${Number(eur[1].replace(',', '.')).toFixed(2)}`;
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
}
