import { unionGroups } from '../domain';

/**
 * Independence groups over case documents: two documents that contain duplicate passages (DUPLICATE_OF) are not independent
 * evidence, so they share one group. Returns docId → group id (the smallest doc id in the group).
 */
export function independenceGroups(docIds: readonly string[], duplicatePairs: readonly (readonly [string, string])[], docOfPassage: (passageId: string) => string | undefined): Map<string, string> {
  const links: [string, string][] = [];
  for (const [p, q] of duplicatePairs) {
    const a = docOfPassage(p);
    const b = docOfPassage(q);
    if (a && b) links.push([a, b]);
  }
  return unionGroups(docIds, links);
}
