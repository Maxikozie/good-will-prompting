import { embedWithLimits } from '../security/model';
import { createHash } from 'node:crypto';
import {
  EdgeIdSchema,
  EvidencePassageSchema,
  EvidenceSnapshotSchema,
  evidencePassageId,
  evidenceSnapshotId,
  type Edge,
  type EvidencePassage,
  type EvidenceSnapshot,
} from '../domain';
import { findDuplicates, partitionReadable, resolveDocument, splitPassages, type DupPassage } from '../evidence';
import { brainRepo, edgeRepo, evidenceRepo } from '../store';
import { defineStage } from './stage';
import { SnapshotInputSchema, SnapshotOutputSchema, type SnapshotDoc } from './types';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * 10 Snapshot: adapt the agent's payload → ACL filter → hash + dedupe → immutable snapshot → heading-aware passages →
 * embeddings → DUPLICATE_OF edges between passages of different case documents (SimHash ≤ 3, cosine ≥ 0.93, or identical).
 * Only the orchestration lives here; the evidence-side logic is in src/evidence.
 */
export const snapshot = defineStage({
  name: '10-snapshot',
  input: SnapshotInputSchema,
  output: SnapshotOutputSchema,
  async run(ctx, input) {
    const nowIso = ctx.now().toISOString();
    const caller = input.principals[0]!;

    // adapter: payload → document + text (unresolvable payloads are counted, not guessed)
    const resolved = [];
    let unresolved = 0;
    for (const payload of input.documents) {
      const r = await resolveDocument(ctx.db, payload, { callerPrincipal: caller, now: nowIso });
      if (r) resolved.push(r);
      else unresolved++;
    }

    // ACL filter BEFORE anything is stored, embedded or sent to a model
    const { readable, denied } = partitionReadable(resolved.map((r) => ({ ...r, allowedPrincipals: r.document.allowedPrincipals })), input.principals);

    // dedupe by content hash (same text under two ids: read it once)
    const seen = new Map<string, string>();
    const unique: typeof readable = [];
    for (const r of [...readable].sort((a, b) => a.document.id.localeCompare(b.document.id))) {
      const hash = sha256(r.text);
      if (seen.has(hash)) continue;
      seen.set(hash, r.document.id);
      unique.push(r);
    }
    const dedupedByHash = readable.length - unique.length;

    const docs: SnapshotDoc[] = [];
    const dupPassages: DupPassage[] = [];
    let passageCount = 0;
    let newSnapshots = 0;
    let embedded = 0;

    for (const { document, text } of unique) {
      const hash = sha256(text);
      await evidenceRepo.upsertDocument(ctx.db, document);
      const latest = await evidenceRepo.latestSnapshot(ctx.db, document.id);
      let snap: EvidenceSnapshot;
      if (latest && latest.contentHash === hash) snap = latest;
      else {
        snap = EvidenceSnapshotSchema.parse({
          id: evidenceSnapshotId(`snap-${document.id}-${hash.slice(0, 12)}`),
          namespace: 'evidence',
          createdAt: nowIso,
          documentId: document.id,
          contentHash: hash,
          text,
          fetchedAt: nowIso,
          version: (await evidenceRepo.maxSnapshotVersion(ctx.db, document.id)) + 1,
        });
        await evidenceRepo.saveSnapshot(ctx.db, snap);
        newSnapshots++;
      }

      // passages: existing rows are the truth (seeded or from an earlier run), otherwise split now
      let passages: EvidencePassage[] = await evidenceRepo.listPassages(ctx.db, snap.id);
      if (passages.length === 0) {
        passages = splitPassages(snap.text).map((s) =>
          EvidencePassageSchema.parse({ id: evidencePassageId(`${snap.id}#${s.ordinal}`), namespace: 'evidence', createdAt: nowIso, snapshotId: snap.id, ordinal: s.ordinal, start: s.start, end: s.end, text: s.text }),
        );
        await evidenceRepo.savePassages(ctx.db, passages);
      }

      // embeddings, once per passage
      const missing = new Set(await evidenceRepo.listPassageIdsWithoutEmbedding(ctx.db, snap.id));
      if (missing.size) {
        const todo = passages.filter((p) => missing.has(p.id));
        const vectors = await embedWithLimits(ctx.embedder, todo.map((p) => p.text));
        for (let i = 0; i < todo.length; i++) await evidenceRepo.setPassageEmbedding(ctx.db, todo[i]!.id, vectors[i]!);
        embedded += todo.length;
      }
      const embeddings = await evidenceRepo.getPassageEmbeddings(ctx.db, snap.id);
      for (const p of passages) dupPassages.push({ id: p.id, documentId: document.id, text: p.text, embedding: embeddings.get(p.id) });

      passageCount += passages.length;
      docs.push({ documentId: document.id, snapshotId: snap.id, contentHash: hash, version: snap.version, passageIds: passages.map((p) => p.id) });
    }

    // DUPLICATE_OF across the case documents of this run (rerunning replaces the run's duplicate edges)
    const dups = findDuplicates(dupPassages);
    await ctx.db.query(`DELETE FROM brain.edge WHERE run_id = $1 AND type = 'DUPLICATE_OF'`, [input.runId]);
    await edgeRepo.insertEdges(
      ctx.db,
      dups.map(
        (d): Edge => ({
          id: EdgeIdSchema.parse(`dup-${createHash('sha1').update(`${input.runId}|${d.from}|${d.to}`).digest('hex').slice(0, 16)}`),
          type: 'DUPLICATE_OF',
          fromId: d.from,
          fromKind: 'evidence_passage',
          toId: d.to,
          toKind: 'evidence_passage',
          props: { method: d.method, score: d.score },
          runId: input.runId,
        }),
      ),
    );

    const run = await brainRepo.getRun(ctx.db, input.runId);
    if (run) await brainRepo.saveRun(ctx.db, { ...run, evidenceSnapshotIds: docs.map((d) => evidenceSnapshotId(d.snapshotId)) });

    return {
      output: { runId: input.runId, documents: docs, duplicatePairs: dups.length },
      stats: {
        received: input.documents.length,
        unresolved,
        aclDenied: denied,
        dedupedByHash,
        documents: docs.length,
        newSnapshots,
        passages: passageCount,
        embedded,
        duplicatePairs: dups.length,
        duplicatesByMethod: dups.reduce<Record<string, number>>((m, d) => ({ ...m, [d.method]: (m[d.method] ?? 0) + 1 }), {}),
      },
    };
  },
});

