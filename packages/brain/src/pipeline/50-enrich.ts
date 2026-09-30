import { createHash } from 'node:crypto';
import {
  EdgeIdSchema,
  FactIdSchema,
  FactSchema,
  matchesQueryScope,
  unionGroups,
  type Edge,
  type EvidenceClaim,
  type EvidenceDocument,
  type EvidenceSnapshot,
  type NormalizeHint,
  type ReferenceFact,
  type SlotTemplate,
  type WikiPage,
  type WikiSection,
} from '../domain';
import { findDuplicates, type DupPassage } from '../evidence';
import { LLMValidationError } from '../llm';
import { buildQueries, embedMissingSections, extractSectionFacts, hopPages, searchSections, type SectionHit } from '../reference';
import { loadEnrichmentConfig } from '../rules/enrichment';
import { brainRepo, edgeRepo, evidenceRepo, referenceRepo } from '../store';
import { planBridges, type BridgeClaim, type BridgeGap, type BridgeRef } from './bridge';
import { defineStage } from './stage';
import { EnrichInputSchema, EnrichOutputSchema } from './types';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const GAP_ORDER = ['MISSING_SLOT', 'UNRESOLVED_CONFLICT', 'WEAK_SUPPORT', 'MISSING_SCOPE', 'MISSING_TEMPORAL'];
const BRIDGE_TYPES = ['FILLS_GAP', 'CORROBORATES', 'ADDS_CONTEXT', 'DERIVED_FROM'] as const;

function hintsFrom(template: SlotTemplate) {
  const byAttribute = new Map(template.slots.map((s) => [s.attribute, s]));
  return (attribute: string): NormalizeHint | undefined => {
    const slot = byAttribute.get(attribute);
    return slot ? { ...(slot.valueType ? { type: slot.valueType } : {}), ...(slot.unit ? { unit: slot.unit } : {}) } : undefined;
  };
}

/**
 * 50 Enrich (reference corpus only): for every open gap build targeted queries (subject + attribute + scope, never the raw question),
 * search the wiki within budget (≤3 queries/gap, ≤12/run, top-k 5, scope + ACL filtered, 1 link hop to pages whose title matches the
 * subject), extract reference facts, run the circularity guard (copies → DERIVED_FROM, independence groups per claim) and link the facts
 * to the case documents with the bridge edges FILLS_GAP / CORROBORATES / CONTRADICTS / ADDS_CONTEXT. Those edges are created only here.
 * Reference facts alone can never exceed PROVISIONAL: facts made only of them are flagged `referenceOnly` (schema-enforced ceiling).
 */
export const enrich = defineStage({
  name: '50-enrich',
  input: EnrichInputSchema,
  output: EnrichOutputSchema,
  async run(ctx, input) {
    const run = await brainRepo.getRun(ctx.db, input.runId);
    if (!run) throw new Error(`unknown run ${input.runId}`);
    const cfg = loadEnrichmentConfig();
    const template = input.slotTemplate;
    const query = run.intent.scope;
    const subject = run.intent.subject;
    const nowIso = ctx.now().toISOString();

    // ---- start from the stage-40 state (rerun-safe)
    await brainRepo.resetEnrichment(ctx.db, input.runId);
    await edgeRepo.deleteEdgesByRun(ctx.db, input.runId, BRIDGE_TYPES);
    await edgeRepo.deleteEdgesByRun(ctx.db, input.runId, ['CONTRADICTS', 'MEMBER_OF'], 'reference_fact');

    // ---- the case documents of this run
    const docs = new Map<string, EvidenceDocument>();
    const snaps = new Map<string, EvidenceSnapshot>(); // by document id
    const passageDoc = new Map<string, string>();
    const evidencePassages: DupPassage[] = [];
    const allClaims: EvidenceClaim[] = []; // every claim of the run (also rejected and context ones) gets an independence group
    for (const snapshotId of run.evidenceSnapshotIds) {
      const snap = await evidenceRepo.getSnapshot(ctx.db, snapshotId);
      const doc = snap && (await evidenceRepo.getDocument(ctx.db, snap.documentId));
      if (!snap || !doc) continue;
      docs.set(doc.id, doc);
      snaps.set(doc.id, snap);
      const emb = await evidenceRepo.getPassageEmbeddings(ctx.db, snap.id);
      allClaims.push(...(await evidenceRepo.listClaimsBySnapshot(ctx.db, snap.id)));
      for (const p of await evidenceRepo.listPassages(ctx.db, snap.id)) {
        passageDoc.set(p.id, doc.id);
        evidencePassages.push({ id: p.id, documentId: doc.id, text: p.text, embedding: emb.get(p.id) });
      }
    }

    // ---- facts, live evidence claims, gaps
    const facts = (await brainRepo.listFacts(ctx.db, input.runId)).filter((f) => f.status !== 'REJECTED');
    const claimOf = new Map<string, EvidenceClaim>();
    const factClaims = new Map<string, EvidenceClaim[]>();
    for (const f of facts) {
      const claims: EvidenceClaim[] = [];
      for (const e of await edgeRepo.edgesTo(ctx.db, f.id, 'MEMBER_OF')) {
        if (e.type !== 'MEMBER_OF' || e.props.role !== 'support') continue;
        const c = await evidenceRepo.getClaim(ctx.db, e.fromId);
        if (c) {
          claims.push(c);
          claimOf.set(c.id, c);
        }
      }
      factClaims.set(f.id, claims);
    }
    const factById = new Map(facts.map((f) => [f.id as string, f]));
    const gapRows = (await brainRepo.listGaps(ctx.db, input.runId)).sort((a, b) => GAP_ORDER.indexOf(a.type) - GAP_ORDER.indexOf(b.type) || a.id.localeCompare(b.id));
    const neededScope = (['country', 'jointCommittee'] as const).filter((k) => !!query[k]);

    const bridgeGaps: BridgeGap[] = gapRows.map((g) => {
      const slot = template.slots.find((s) => s.id === g.slotId);
      const fact = g.factId ? factById.get(g.factId) : undefined;
      const claims = (fact && factClaims.get(fact.id)) ?? [];
      const missingScope = neededScope.filter((k) => !claims.some((c) => !!c.qualifiers[k]));
      return { id: g.id, type: g.type, ...(g.slotId ? { slotId: g.slotId } : {}), attribute: fact?.attribute ?? slot?.attribute ?? '', ...(g.factId ? { factId: g.factId } : {}), missingScope };
    });

    // ---- wiki: embeddings for any section that has none yet
    const embeddedSections = await embedMissingSections(ctx.db, ctx.embedder);

    // ---- gap-targeted search within budget
    const hitsBySection = new Map<string, SectionHit>();
    const searches = new Map<string, SectionHit[]>();
    let issued = 0;
    let reused = 0;
    let skippedByBudget = 0;
    for (const gap of bridgeGaps) {
      const fact = gap.factId ? factById.get(gap.factId) : undefined;
      const target = gap.type === 'MISSING_TEMPORAL' ? 'effective_from' : gap.attribute;
      if (!target) continue;
      const values = gap.type === 'MISSING_SLOT' ? [] : [...new Set((fact ? (factClaims.get(fact.id) ?? []) : []).filter((c) => c.modality === 'rule').map((c) => c.value.raw))].slice(0, 3);
      for (const q of buildQueries({ cfg, template, subject, attribute: target, scope: query, values })) {
        let hits = searches.get(q.text);
        if (hits) reused++;
        else if (issued >= cfg.budgets.maxQueriesPerRun) {
          skippedByBudget++;
          continue;
        } else {
          hits = await searchSections(ctx.db, ctx.embedder, cfg, { text: q.text, principals: input.principals, scope: query });
          searches.set(q.text, hits);
          issued++;
        }
        for (const h of hits) {
          const prev = hitsBySection.get(h.section.id);
          if (!prev || h.score > prev.score) hitsBySection.set(h.section.id, h);
        }
      }
    }
    const retrievedPages = new Map<string, WikiPage>();
    for (const h of hitsBySection.values()) retrievedPages.set(h.page.id, h.page);
    const terms = cfg.subjects[subject]?.terms ?? [template.label, ...subject.split('.')];
    const hopped = await hopPages(ctx.db, cfg, { from: [...retrievedPages.values()], terms, principals: input.principals, scope: query });
    for (const p of hopped) retrievedPages.set(p.id, p);
    const pages = [...retrievedPages.values()].sort((a, b) => a.id.localeCompare(b.id));

    // ---- extract reference facts from every section of the retrieved pages (a page is the unit of a wiki, not one paragraph)
    const hintFor = hintsFrom(template);
    const refFacts: ReferenceFact[] = [];
    const sectionOfFact = new Map<string, { section: WikiSection; page: WikiPage; snapshotId: string }>();
    const pageSections = new Map<string, { snapshotId: string; text: string; sections: WikiSection[]; embeddings: Map<string, number[]> }>();
    let sectionsExtracted = 0;
    let dropped = 0;
    let failures = 0;
    let offSubject = 0;
    let outOfScope = 0;
    for (const page of pages) {
      const latest = await referenceRepo.listLatestSections(ctx.db, page.id);
      if (!latest) continue;
      pageSections.set(page.id, { snapshotId: latest.snapshot.id, text: latest.snapshot.text, sections: latest.sections, embeddings: await referenceRepo.getSectionEmbeddings(ctx.db, latest.snapshot.id) });
      for (const section of latest.sections) {
        sectionsExtracted++;
        try {
          const r = await extractSectionFacts({ provider: ctx.llm, page, snapshot: latest.snapshot, section, hintFor, now: nowIso });
          dropped += r.droppedNotVerbatim;
          const keep: ReferenceFact[] = [];
          for (const f of r.facts) {
            if (f.subject !== subject) offSubject++;
            else if (!matchesQueryScope(f.qualifiers, query)) outOfScope++;
            else keep.push(f);
          }
          await referenceRepo.saveFacts(ctx.db, keep);
          for (const f of keep) {
            refFacts.push(f);
            sectionOfFact.set(f.id, { section, page, snapshotId: latest.snapshot.id });
          }
        } catch (e) {
          if (!(e instanceof LLMValidationError)) throw e;
          failures++;
        }
      }
    }

    // ---- circularity guard: copies of case documents (SimHash ≤ 3, cosine ≥ 0.93, or an explicit link) → DERIVED_FROM
    const sectionPassages: DupPassage[] = [];
    for (const [pageId, ps] of pageSections) for (const s of ps.sections) sectionPassages.push({ id: s.id, documentId: pageId, text: s.text, embedding: ps.embeddings.get(s.id) });
    const evidenceIds = new Set(evidencePassages.map((p) => p.id));
    const sectionIds = new Set(sectionPassages.map((p) => p.id));
    const cross = findDuplicates([...evidencePassages, ...sectionPassages]).filter((d) => (evidenceIds.has(d.from) && sectionIds.has(d.to)) || (sectionIds.has(d.from) && evidenceIds.has(d.to)));

    interface Derived { sectionId: string; pageId: string; docId: string; method: 'exact' | 'simhash' | 'cosine' | 'link'; score: number }
    const derivedSections = new Map<string, Derived>(); // sectionId → best match
    const sectionPage = new Map<string, string>();
    for (const [pageId, ps] of pageSections) for (const s of ps.sections) sectionPage.set(s.id, pageId);
    for (const d of cross) {
      const sectionId = sectionIds.has(d.from) ? d.from : d.to;
      const passageId = sectionId === d.from ? d.to : d.from;
      const prev = derivedSections.get(sectionId);
      if (!prev || d.score > prev.score) derivedSections.set(sectionId, { sectionId, pageId: sectionPage.get(sectionId)!, docId: passageDoc.get(passageId)!, method: d.method, score: d.score });
    }
    const pageLevel = new Map<string, Derived>(); // `${pageId}|${docId}` → page-level copy
    for (const [pageId, ps] of pageSections) {
      const page = retrievedPages.get(pageId)!;
      for (const [docId, doc] of docs) {
        const mine = [...derivedSections.values()].filter((d) => d.pageId === pageId && d.docId === docId);
        const linked = ps.text.includes(doc.sourceUri) || (snaps.get(docId)?.text ?? '').includes(page.uri);
        if (linked) pageLevel.set(`${pageId}|${docId}`, { sectionId: '', pageId, docId, method: 'link', score: 1 });
        else if (mine.length && mine.length / ps.sections.length >= 0.5) {
          const best = mine.reduce((a, b) => (b.score > a.score ? b : a));
          pageLevel.set(`${pageId}|${docId}`, { sectionId: '', pageId, docId, method: best.method, score: mine.reduce((s, d) => s + d.score, 0) / mine.length });
        }
      }
    }

    // ---- independence groups (evidence DUPLICATE_OF + page-level copies), then one group id per claim for the run
    const runEdges = await edgeRepo.edgesByRun(ctx.db, input.runId);
    const links: [string, string][] = [];
    for (const e of runEdges) if (e.type === 'DUPLICATE_OF') links.push([passageDoc.get(e.fromId) ?? '', passageDoc.get(e.toId) ?? '']);
    for (const d of pageLevel.values()) links.push([d.pageId, d.docId]);
    const groupOf = unionGroups([...docs.keys(), ...pages.map((p) => p.id as string)], links.filter(([a, b]) => a && b));
    const evidenceGroups = new Set([...docs.keys()].map((d) => groupOf.get(d)!));
    const refGroup = (f: ReferenceFact) => {
      const d = derivedSections.get(sectionOfFact.get(f.id)!.section.id);
      return d ? groupOf.get(d.docId)! : groupOf.get(f.sourceId)!; // a copied section belongs to the group of its original
    };
    await brainRepo.saveClaimGroups(ctx.db, [
      ...allClaims.map((c) => ({ runId: input.runId, claimId: c.id, sourceKind: 'evidence' as const, sourceId: c.sourceId, groupId: groupOf.get(c.sourceId)! })),
      ...refFacts.map((f) => ({ runId: input.runId, claimId: f.id, sourceKind: 'reference' as const, sourceId: f.sourceId, groupId: refGroup(f) })),
    ]);

    // ---- plan and write the bridges
    const refs: BridgeRef[] = refFacts.map((f) => {
      const g = refGroup(f);
      const hit = hitsBySection.get(sectionOfFact.get(f.id)!.section.id);
      return { id: f.id, attribute: f.attribute, value: f.value, polarity: f.polarity, modality: f.modality, conditions: f.qualifiers.conditions, effectiveFrom: f.temporal.effectiveFrom, scope: f.qualifiers, score: Math.max(0, Math.min(1, hit?.score ?? 0.5)), derived: evidenceGroups.has(g), group: g };
    });
    const bridgeFacts = facts.map((f) => ({
      id: f.id as string,
      attribute: f.attribute,
      claims: (factClaims.get(f.id) ?? []).filter((c) => c.modality === 'rule').map((c): BridgeClaim => ({ id: c.id, value: c.value, polarity: c.polarity, conditions: c.qualifiers.conditions, effectiveFrom: c.temporal.effectiveFrom })),
    }));
    const plan = planBridges(refs, bridgeFacts, bridgeGaps);

    const eid = (type: string, from: string, to: string) => EdgeIdSchema.parse(`br-${sha1(`${input.runId}|${type}|${from}|${to}`).slice(0, 16)}`);
    const edges: Edge[] = [];
    for (const f of plan.fills) edges.push({ id: eid('FILLS_GAP', f.refId, f.gapId), type: 'FILLS_GAP', fromId: f.refId, fromKind: 'reference_fact', toId: f.gapId, toKind: 'gap', props: { score: f.score }, runId: input.runId });
    for (const c of plan.corroborates) edges.push({ id: eid('CORROBORATES', c.refId, c.factId), type: 'CORROBORATES', fromId: c.refId, fromKind: 'reference_fact', toId: c.factId, toKind: 'fact', props: { score: c.score }, runId: input.runId });
    for (const c of plan.contradicts) edges.push({ id: eid('CONTRADICTS', c.refId, c.claimId), type: 'CONTRADICTS', fromId: c.refId, fromKind: 'reference_fact', toId: c.claimId, toKind: 'evidence_claim', props: { type: c.type, severity: 'medium', explanation: c.explanation, method: 'rule' }, runId: input.runId });
    for (const c of plan.context) edges.push({ id: eid('ADDS_CONTEXT', c.refId, c.target.id), type: 'ADDS_CONTEXT', fromId: c.refId, fromKind: 'reference_fact', toId: c.target.id, toKind: c.target.kind, props: { score: c.score }, runId: input.runId });

    // DERIVED_FROM: newer → older (the copy points at its original); section level and page level
    const newerFirst = (pageId: string, docId: string) => (retrievedPages.get(pageId)!.lastEditedAt >= docs.get(docId)!.lastEditedAt ? 'wiki' : 'evidence');
    const derivedEdge = (kind: 'wiki_section' | 'wiki_snapshot', wikiId: string, d: Derived): Edge => {
      const evId = snaps.get(d.docId)!.id;
      const wikiNewer = newerFirst(d.pageId, d.docId) === 'wiki';
      return { id: eid('DERIVED_FROM', wikiNewer ? wikiId : evId, wikiNewer ? evId : wikiId), type: 'DERIVED_FROM', fromId: wikiNewer ? wikiId : evId, fromKind: wikiNewer ? kind : 'evidence_snapshot', toId: wikiNewer ? evId : wikiId, toKind: wikiNewer ? 'evidence_snapshot' : kind, props: { method: d.method, score: d.score }, runId: input.runId };
    };
    for (const d of derivedSections.values()) edges.push(derivedEdge('wiki_section', d.sectionId, d));
    for (const d of pageLevel.values()) edges.push(derivedEdge('wiki_snapshot', pageSections.get(d.pageId)!.snapshotId, d));

    // slots filled only by the reference corpus get a referenceOnly fact (status ceiling PROVISIONAL, decided in stage 60)
    const refById = new Map(refFacts.map((f) => [f.id as string, f]));
    const newFacts = new Map<string, string>(); // gapId → fact id
    for (const r of plan.referenceOnlyFacts) {
      const members = r.refIds.map((id) => refById.get(id)!).sort((a, b) => a.id.localeCompare(b.id));
      const id = FactIdSchema.parse(`fact-${sha1(`${input.runId}|reference|${r.attribute}`).slice(0, 16)}`);
      await brainRepo.saveFact(
        ctx.db,
        FactSchema.parse({
          id, namespace: 'brain', createdAt: nowIso, runId: input.runId, claimKey: members.map((m) => m.claimKey).sort()[0], subject, attribute: r.attribute, scope: query, slotId: r.slotId,
          status: 'UNKNOWN', confidence: 0, reasons: [{ code: 'REFERENCE_ONLY', message: 'Supported only by the wiki (reference corpus): at most PROVISIONAL until evidence or an owner confirms it.' }],
          needsVerification: false, impact: template.impact, referenceOnly: true,
        }),
      );
      newFacts.set(r.gapId, id);
      for (const m of members) edges.push({ id: eid('MEMBER_OF', m.id, id), type: 'MEMBER_OF', fromId: m.id, fromKind: 'reference_fact', toId: id, toKind: 'fact', props: { role: 'support', reason: 'REFERENCE_ONLY' }, runId: input.runId });
    }
    await edgeRepo.insertEdges(ctx.db, edges);

    const closed: string[] = [];
    const partial: string[] = [];
    for (const c of plan.closures) {
      await brainRepo.updateGap(ctx.db, c.gapId, { status: c.status, closedBy: c.closedBy, ...(newFacts.has(c.gapId) ? { factId: newFacts.get(c.gapId) } : {}) });
      (c.status === 'closed' ? closed : partial).push(c.gapId);
    }

    const bridges: Record<string, number> = {};
    for (const e of edges) bridges[e.type] = (bridges[e.type] ?? 0) + 1;
    return {
      output: { runId: input.runId, referenceFactIds: refFacts.map((f) => f.id), closedGapIds: closed, partiallyClosedGapIds: partial, bridges, queriesIssued: issued },
      stats: {
        gapsConsidered: bridgeGaps.length,
        queriesIssued: issued,
        queriesReused: reused,
        queriesSkippedByBudget: skippedByBudget,
        budget: { perGap: cfg.budgets.maxQueriesPerGap, perRun: cfg.budgets.maxQueriesPerRun, topK: cfg.budgets.topK, linkHops: cfg.budgets.maxLinkHops },
        pagesRetrieved: pages.length - hopped.length,
        pagesFromLinkHop: hopped.length,
        pages: pages.map((p) => p.id),
        sectionsEmbedded: embeddedSections,
        sectionsExtracted,
        referenceFacts: refFacts.length,
        droppedNotVerbatim: dropped,
        droppedOffSubject: offSubject,
        droppedOutOfScope: outOfScope,
        extractionFailures: failures,
        derivedSections: derivedSections.size,
        derivedPages: [...pageLevel.values()].map((d) => d.pageId),
        independenceGroups: new Set([...groupOf.values()]).size,
        referenceOnlyFacts: plan.referenceOnlyFacts.length,
        bridges,
        gapsClosed: closed.length,
        gapsPartiallyClosed: partial.length,
      },
    };
  },
});
