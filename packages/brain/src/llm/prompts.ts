import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LLMError } from './errors';
import type { Message } from './types';

// Versioned prompt files live in packages/brain/prompts/<id>.<version>.md:
//   frontmatter (id, version, output, trusted: [vars])  ·  "## system"  ·  "## user" with {{placeholders}}.
// Every prompt wraps untrusted content in <document> tags, says that content is data, demands JSON only and verbatim quotes.

export const PROMPTS_DIR = path.resolve(import.meta.dirname, '..', '..', 'prompts');
export const PROMPT_IDS = ['intake', 'extract-evidence', 'extract-reference', 'relation-classify', 'compose'] as const;
export type PromptId = (typeof PROMPT_IDS)[number];
export const CURRENT_VERSION = 'v1';

export interface PromptTemplate {
  id: PromptId;
  version: string;
  output: string;
  /** Placeholders whose values are NOT untrusted (inserted as is). Everything else is sanitized. */
  trusted: string[];
  system: string;
  user: string;
  /** sha256 of the file, for auditing. */
  hash: string;
}

const cache = new Map<string, PromptTemplate>();

export function loadPrompt(id: PromptId, version = CURRENT_VERSION): PromptTemplate {
  const key = `${id}.${version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!/^[a-z-]+$/.test(id) || !/^v\d+$/.test(version)) throw new LLMError(`bad prompt id/version: ${key}`);
  const file = path.join(PROMPTS_DIR, `${key}.md`);
  if (!fs.existsSync(file)) throw new LLMError(`prompt file not found: prompts/${key}.md`);
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new LLMError(`prompt ${key}: missing frontmatter`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  if (meta.id !== id || meta.version !== version) throw new LLMError(`prompt ${key}: frontmatter id/version does not match the file name`);
  const parts = m[2]!.match(/^## system\n([\s\S]*?)\n## user\n([\s\S]*)$/);
  if (!parts) throw new LLMError(`prompt ${key}: needs "## system" followed by "## user"`);
  const trusted = (meta.trusted ?? '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const tpl: PromptTemplate = { id, version, output: meta.output ?? '', trusted, system: parts[1]!.trim(), user: parts[2]!.trim(), hash: createHash('sha256').update(src).digest('hex') };
  cache.set(key, tpl);
  return tpl;
}

/** `{ intake: "intake.v1", … }` for CaseRun.promptVersions. */
export function promptVersions(): Record<string, string> {
  return Object.fromEntries(PROMPT_IDS.map((id) => [id, `${id}.${CURRENT_VERSION}`]));
}

/** Keep untrusted text from closing or faking the <document> wrapper. */
export function sanitizeUntrusted(text: string): string {
  return text.replace(/<(\/?\s*document)/gi, '‹$1').split('\u0000').join('');
}

/** Render a template. Values of placeholders not listed in `trusted` are sanitized; unknown or missing placeholders throw. */
export function renderPrompt(tpl: PromptTemplate, vars: Record<string, string>): Message[] {
  const used = new Set<string>();
  const fill = (s: string) =>
    s.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
      const v = vars[name];
      if (v === undefined) throw new LLMError(`prompt ${tpl.id}.${tpl.version}: missing variable "${name}"`);
      used.add(name);
      return tpl.trusted.includes(name) ? v : sanitizeUntrusted(v);
    });
  const messages: Message[] = [
    { role: 'system', content: fill(tpl.system) },
    { role: 'user', content: fill(tpl.user) },
  ];
  for (const name of Object.keys(vars)) if (!used.has(name)) throw new LLMError(`prompt ${tpl.id}.${tpl.version}: unknown variable "${name}"`);
  return messages;
}

// ---- prompt-injection flagging (SPEC §13: "strip/flag instruction-like text")
const INJECTION_PATTERNS: [string, RegExp][] = [
  ['ignore-previous-instructions', /\b(ignore|disregard|forget|negeer|oublie[rz]?|ignorez)\b.{0,40}\b(previous|prior|above|earlier|all|eerdere|vorige|alle|pr[ée]c[ée]dentes?|toutes)\b.{0,30}\b(instructions?|instructies|regels|rules|consignes)\b/is],
  ['system-prompt-talk', /\b(system\s*(prompt|message|instruction)|systeem\s?(prompt|instructie)|syst[èe]me\s*instruction)/i],
  ['note-to-ai', /\b(note|opmerking|remarque)\s+(for|voor|pour)\s+(ai|llm|assistant|ki|ia)/i],
  ['mark-as-verified', /\b(mark|markeer|marque[rz]?|set)\b.{0,40}\b(verified|geverifieerd|v[ée]rifi[ée])/i],
  ['role-override', /\b(you are now|from now on you|je bent nu|vous [êe]tes maintenant)\b/i],
  ['only-this-source', /\b(only|enkel|uniquement)\b.{0,30}\b(this|dit|ce)\b.{0,20}\b(document|source|bron)\b/i],
];

/** Names of instruction-like patterns found in a document (empty = clean). Flags, never blocks: the text stays data. */
export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}
