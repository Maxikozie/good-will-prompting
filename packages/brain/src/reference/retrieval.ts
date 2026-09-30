import { embedWithLimits } from '../security/model';
import { matchesQueryScope, type Scope, type WikiPage, type WikiSection } from '../domain';
import type { Embedder } from '../llm';
import type { EnrichmentConfig } from '../rules/enrichment';
import type { Db } from '../store/db';
import * as repo from '../store/reference-repo';

export interface SectionHit {
  section: WikiSection;
  page: WikiPage;
  score: number;
}

/**
 * One budgeted search: embed the query, take the nearest sections of pages the caller may read (ACL in SQL),
 * drop pages whose declared scope conflicts with the question's scope, keep the top-k.
 */
export async function searchSections(db: Db, embedder: Embedder, cfg: EnrichmentConfig, args: { text: string; principals: readonly string[]; scope: Scope }): Promise<SectionHit[]> {
  const [vector] = await embedWithLimits(embedder, [args.text]);
  const raw = await repo.searchVisibleSections(db, vector!, { principals: args.principals, k: cfg.budgets.topK * cfg.budgets.overFetch });
  const pages = new Map((await repo.getPagesByIds(db, [...new Set(raw.map((h) => h.pageId))])).map((p) => [p.id as string, p]));
  const hits: SectionHit[] = [];
  for (const h of raw) {
    const page = pages.get(h.pageId);
    if (!page || !matchesQueryScope(page.declaredScope, args.scope)) continue; // scope filter: a page about another country/committee is never evidence
    hits.push({ section: h.section, page, score: h.score });
    if (hits.length >= cfg.budgets.topK) break;
  }
  return hits;
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Does a page title mention the subject (any of its terms)? */
export function titleMatchesSubject(title: string, terms: readonly string[]): boolean {
  const t = fold(title);
  return terms.some((x) => t.includes(fold(x)));
}

/**
 * Link hop: from the retrieved pages, follow their outLinks up to `maxLinkHops` hops, but only to pages the caller may read,
 * that fit the question's scope and whose TITLE matches the subject. Returns the extra pages (not the ones already retrieved).
 */
export async function hopPages(db: Db, cfg: EnrichmentConfig, args: { from: readonly WikiPage[]; terms: readonly string[]; principals: readonly string[]; scope: Scope }): Promise<WikiPage[]> {
  const seen = new Set(args.from.map((p) => p.id as string));
  const out: WikiPage[] = [];
  let frontier = [...args.from];
  for (let hop = 0; hop < cfg.budgets.maxLinkHops; hop++) {
    const ids = [...new Set(frontier.flatMap((p) => p.outLinks as string[]))].filter((id) => !seen.has(id));
    if (!ids.length) break;
    const next = (await repo.getPagesByIds(db, ids)).filter(
      (p) => (p.allowedPrincipals.some((a) => a === '*' || args.principals.includes(a))) && matchesQueryScope(p.declaredScope, args.scope) && titleMatchesSubject(p.title, args.terms),
    );
    for (const p of next) seen.add(p.id);
    out.push(...next);
    frontier = next;
  }
  return out;
}
