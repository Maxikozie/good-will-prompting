import { LLMValidationError } from '../llm';
import { extractPassageClaims } from '../evidence';
import type { NormalizeHint, SlotTemplate } from '../domain';
import { evidenceRepo } from '../store';
import { defineStage } from './stage';
import { ExtractInputSchema, ExtractOutputSchema } from './types';

function hintsFrom(template: SlotTemplate) {
  const byAttribute = new Map(template.slots.map((s) => [s.attribute, s]));
  return (attribute: string): NormalizeHint | undefined => {
    const slot = byAttribute.get(attribute);
    if (!slot) return undefined;
    return { ...(slot.valueType ? { type: slot.valueType } : {}), ...(slot.unit ? { unit: slot.unit } : {}) };
  };
}

/**
 * 20 Extract: for every passage of the run's snapshots, LLM extraction → verbatim check (drops are counted) → deterministic
 * normalizer → declaredScope fallback (SCOPE_UNDECLARED when no country anywhere) → claimKey → persisted as evidence claims.
 */
export const extract = defineStage({
  name: '20-extract',
  input: ExtractInputSchema,
  output: ExtractOutputSchema,
  async run(ctx, input) {
    const hintFor = hintsFrom(input.slotTemplate);
    const nowIso = ctx.now().toISOString();
    const claimIds: string[] = [];
    const claimsByDocument: Record<string, number> = {};
    const scopeUndeclared: string[] = [];
    const injection: { documentId: string; passageId: string; flags: string[] }[] = [];
    let passages = 0;
    let rawClaims = 0;
    let dropped = 0;
    let failures = 0;

    for (const snapshotId of [...input.snapshotIds].sort()) {
      const snap = await evidenceRepo.getSnapshot(ctx.db, snapshotId);
      if (!snap) continue;
      const document = await evidenceRepo.getDocument(ctx.db, snap.documentId);
      if (!document) continue;
      claimsByDocument[document.id] = 0;
      for (const passage of await evidenceRepo.listPassages(ctx.db, snap.id)) {
        passages++;
        try {
          const r = await extractPassageClaims({ provider: ctx.llm, document, snapshot: snap, passage, hintFor, now: nowIso });
          rawClaims += r.raw;
          dropped += r.droppedNotVerbatim;
          scopeUndeclared.push(...r.scopeUndeclared);
          if (r.injection.length) injection.push({ documentId: document.id, passageId: passage.id, flags: r.injection });
          await evidenceRepo.saveClaims(ctx.db, r.claims);
          for (const c of r.claims) claimIds.push(c.id);
          claimsByDocument[document.id]! += r.claims.length;
        } catch (e) {
          if (!(e instanceof LLMValidationError)) throw e; // a missing fixture / transport error must be loud; a model that cannot produce valid JSON only costs this passage
          failures++;
          ctx.log(`extract: ${passage.id} failed validation after retries`);
        }
      }
    }

    return {
      output: { runId: input.runId, claimIds, claimsByDocument },
      stats: {
        snapshots: input.snapshotIds.length,
        passages,
        claimsReturned: rawClaims,
        claimsKept: claimIds.length,
        droppedNotVerbatim: dropped,
        scopeUndeclared: scopeUndeclared.length,
        injectionFlaggedPassages: injection.length,
        injection,
        extractionFailures: failures,
        claimsByDocument,
      },
    };
  },
});
