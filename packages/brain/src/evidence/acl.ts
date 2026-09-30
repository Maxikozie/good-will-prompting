import type { EvidenceDocument } from '../domain';

/** ACL check (SPEC §13): a document is readable if it is open to everyone ("*") or shares a principal with the caller. */
export function canRead(doc: Pick<EvidenceDocument, 'allowedPrincipals'>, principals: readonly string[]): boolean {
  return doc.allowedPrincipals.some((p) => p === '*' || principals.includes(p));
}

export function partitionReadable<T extends Pick<EvidenceDocument, 'allowedPrincipals'>>(docs: readonly T[], principals: readonly string[]): { readable: T[]; denied: number } {
  const readable = docs.filter((d) => canRead(d, principals));
  return { readable, denied: docs.length - readable.length };
}
