/**
 * Independence groups over source documents (SPEC §1 circularity guard): two documents that contain duplicate passages
 * (DUPLICATE_OF) are not independent evidence, so they share one group. A document on its own is its own group.
 * Returns docId → group id (the smallest doc id in the group, so it is stable).
 */
export function independenceGroups(docIds: readonly string[], duplicatePairs: readonly (readonly [string, string])[], docOfPassage: (passageId: string) => string | undefined): Map<string, string> {
  const parent = new Map<string, string>(docIds.map((d) => [d, d]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const [p, q] of duplicatePairs) {
    const a = docOfPassage(p);
    const b = docOfPassage(q);
    if (!a || !b || !parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra > rb ? ra : rb, ra > rb ? rb : ra);
  }
  return new Map(docIds.map((d) => [d, find(d)]));
}
