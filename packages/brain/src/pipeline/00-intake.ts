import { createHash } from 'node:crypto';
import { CaseRunSchema, QueryIntentSchema, mergeScope, principalId, runId, ScopeSchema, type RunId, type Scope } from '../domain';
import { intakeTask, promptVersions, runTask, type KnownSubject } from '../llm';
import { generatedTemplate } from '../rules/slots';
import { brainRepo } from '../store';
import { defineStage } from './stage';
import { IntakeInputSchema, IntakeOutputSchema } from './types';

/**
 * 00 Intake: question + principal → QueryIntent (LLM, schema-validated) → slot template, and the CaseRun row.
 * The caller's scopeHint wins over what the model read from the question; an unknown subject gets model-proposed slots
 * (`generatedSlots: true`, required slots weigh 0.8).
 */
export const intake = defineStage({
  name: '00-intake',
  input: IntakeInputSchema,
  output: IntakeOutputSchema,
  async run(ctx, input) {
    const subjects: KnownSubject[] = ctx.templates.map((t) => ({ subject: t.subject, label: t.label }));
    const out = await runTask(ctx.llm, intakeTask(input.question, subjects));

    const known = ctx.templates.find((t) => t.subject === out.subject);
    const generatedSlots = !known;
    const slotTemplate = known ?? generatedTemplate(out.subject, out.proposedSlots);

    const merged = mergeScope(out.scope, input.scopeHint);
    const scope: Scope = ScopeSchema.parse({ ...merged, country: merged.country ?? null });
    const intent = QueryIntentSchema.parse({ subject: out.subject, scope, questionType: out.questionType, slotTemplateId: generatedSlots ? `generated:${out.subject}` : known!.subject, generatedSlots });

    const startedAt = ctx.now().toISOString();
    const id: RunId = input.runId ?? runId(`run-${createHash('sha1').update(`${input.question}|${input.principalId}|${startedAt}`).digest('hex').slice(0, 12)}`);
    await brainRepo.saveRun(
      ctx.db,
      CaseRunSchema.parse({
        id,
        namespace: 'brain',
        createdAt: startedAt,
        question: input.question,
        principalId: principalId(input.principalId),
        intent,
        status: 'running',
        rulesVersion: ctx.rulesVersion,
        promptVersions: promptVersions(),
        modelIds: { llm: ctx.llm.modelId, embedder: ctx.embedder.modelId },
        evidenceSnapshotIds: [],
        referenceSnapshotIds: [],
        startedAt,
      }),
    );
    return {
      output: { runId: id, intent, slotTemplate },
      stats: { subject: out.subject, generatedSlots, scopeFromHint: Object.keys(input.scopeHint ?? {}).length, slots: slotTemplate.slots.length },
    };
  },
});
