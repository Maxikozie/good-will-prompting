import { z } from 'zod';
import { PageSchema, RawMetaSchema, TaskSchema, QuerySchema } from './input-schemas';
import { readJson, readText, parseJson, parseYaml, boundText, isSafeFileName, resolveInside } from '../../packages/brain/src/security/input';
import fs from 'node:fs';
import { stringify } from 'yaml';
import type { QueryLogEntry, Task, WikiPage } from './types';
import { HASH_RE, META_DIR, PAGE_ID_RE, RAW_DIR, TASK_ID_RE, WIKI_DIR } from './util';

// The vault is plain files so it opens in Obsidian and diffs in git:
//   vault/raw/<sha256>.<ext>   immutable source copies (provenance)
//   vault/wiki/<page-id>.md    one page per knowledge item, YAML frontmatter + markdown
//   vault/.meta/               tasks.json, queries.log, raw-manifest.json
// Files are only ever addressed by validated ids/hashes, never by a user-supplied path.

// Resolved per call through resolveInside, so a symlink swapped into the vault cannot redirect reads/writes outside it.
const tasksFile = () => resolveInside(META_DIR, 'tasks.json');
const queriesFile = () => resolveInside(META_DIR, 'queries.log');
const manifestFile = () => resolveInside(META_DIR, 'raw-manifest.json');

export interface RawMeta {
  source_id: string;
  origin: string;
  original: string;
  ingested_at: string;
  ext: 'md' | 'json';
}

export function ensureVaultDirs(): void {
  for (const d of [RAW_DIR, WIKI_DIR, META_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function vaultExists(): boolean {
  return fs.existsSync(WIKI_DIR) && fs.readdirSync(WIKI_DIR).some((f) => f.endsWith('.md'));
}

// ---------- frontmatter ----------

export function splitFrontmatter(src: string): { data: Record<string, unknown>; body: string } {
  boundText(src);
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: src };
  const data = z.record(z.string(), z.unknown()).parse(parseYaml(m[1]) ?? {});
  return { data, body: m[2] };
}

// ---------- wiki pages ----------

function pagePath(id: string): string {
  if (!PAGE_ID_RE.test(id)) throw new Error('Invalid page id');
  return resolveInside(WIKI_DIR, `${id}.md`);
}

function toPage(id: string, src: string): WikiPage {
  const { data, body } = splitFrontmatter(src);
  return PageSchema.parse({ ...data, id, body: body.trim() });
}

export function listPages(): WikiPage[] {
  if (!fs.existsSync(WIKI_DIR)) return [];
  return fs
    .readdirSync(WIKI_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .filter((id) => PAGE_ID_RE.test(id))
    .map((id) => toPage(id, readText(pagePath(id))))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getPage(id: string): WikiPage | null {
  if (!PAGE_ID_RE.test(id)) return null;
  const p = pagePath(id);
  if (!fs.existsSync(p)) return null;
  return toPage(id, readText(p));
}

export function savePage(page: WikiPage): void {
  const { id, body, ...meta } = PageSchema.parse(page);
  const fm = stringify({ id, ...meta }, { lineWidth: 0 }).trimEnd();
  fs.writeFileSync(pagePath(id), `---\n${fm}\n---\n\n${body.trim()}\n`, 'utf8');
}

// ---------- raw store (content-addressed, write-once) ----------

function readManifest(): Record<string, RawMeta> {
  const file = manifestFile();
  if (!fs.existsSync(file)) return {};
  return readJson(file, z.record(z.string(), RawMetaSchema));
}

export function putRaw(hash: string, content: string, meta: RawMeta): void {
  if (!HASH_RE.test(hash)) throw new Error('Invalid hash');
  const file = resolveInside(RAW_DIR, `${hash}.${meta.ext === 'json' ? 'json' : 'md'}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
  const manifest = readManifest();
  if (!manifest[hash]) {
    manifest[hash] = meta;
    fs.writeFileSync(manifestFile(), JSON.stringify(manifest, null, 2), 'utf8');
  }
}

export function getRaw(hash: string): { hash: string; content: string; meta: RawMeta } | null {
  if (!HASH_RE.test(hash)) return null;
  const meta = readManifest()[hash];
  if (!meta) return null;
  const ext = meta.ext === 'json' ? 'json' : 'md';
  const file = resolveInside(RAW_DIR, `${hash}.${ext}`);
  if (!fs.existsSync(file)) return null;
  return { hash, content: readText(file), meta };
}

// ---------- tasks ----------

export function loadTasks(): Task[] {
  const file = tasksFile();
  if (!fs.existsSync(file)) return [];
  return readJson(file, z.array(TaskSchema));
}

export function saveTasks(tasks: Task[]): void {
  fs.writeFileSync(tasksFile(), JSON.stringify(tasks, null, 2), 'utf8');
}

export function getTask(id: string): Task | null {
  if (!TASK_ID_RE.test(id)) return null;
  return loadTasks().find((t) => t.id === id) ?? null;
}

// ---------- query log (gap detection) ----------

export function appendQuery(entry: QueryLogEntry): void {
  fs.appendFileSync(queriesFile(), JSON.stringify(entry) + '\n', 'utf8');
}

export function loadQueries(): QueryLogEntry[] {
  const file = queriesFile();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [QuerySchema.parse(parseJson(line))];
      } catch {
        return [];
      }
    });
}

export function resetMeta(): void {
  if (fs.existsSync(WIKI_DIR)) {
    for (const f of fs.readdirSync(WIKI_DIR)) if (isSafeFileName(f, '.md')) fs.unlinkSync(resolveInside(WIKI_DIR, f));
  }
  for (const f of [tasksFile(), queriesFile()]) if (fs.existsSync(f)) fs.unlinkSync(f);
}
