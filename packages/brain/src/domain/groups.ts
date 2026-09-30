/**
 * Independence groups (SPEC §1 circularity guard) as a union-find over source ids (case documents AND wiki pages):
 * sources linked by a copy relation (DUPLICATE_OF / DERIVED_FROM) count once. Returns sourceId → group id, where the
 * group id is the smallest source id in the group, so it is stable and order-independent.
 */
export function unionGroups(ids: readonly string[], links: readonly (readonly [string, string])[]): Map<string, string> {
  const parent = new Map<string, string>(ids.map((d) => [d, d]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of links) {
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra > rb ? ra : rb, ra > rb ? rb : ra);
  }
  return new Map(ids.map((d) => [d, find(d)]));
}
