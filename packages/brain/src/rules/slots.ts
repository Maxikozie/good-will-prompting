import fs from 'node:fs';
import path from 'node:path';
import { readYaml } from '../security/input';
import { SlotTemplateSchema, type Slot, type SlotTemplate } from '../domain';

export const SLOTS_DIR = path.resolve(import.meta.dirname, '..', '..', 'slots');

/** Load and validate every slots/<subject>.yaml. */
export function loadSlotTemplates(dir = SLOTS_DIR): SlotTemplate[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => readYaml(path.join(dir, f), SlotTemplateSchema));
}

/** Weight multiplier for slots the LLM proposed instead of a human-written template (SPEC §4). */
export const GENERATED_SLOT_FACTOR = 0.8;

/** Template for a subject the intake step did not find on disk: slots proposed by the model, weights ×0.8. */
export function generatedTemplate(subject: string, proposed: readonly { id: string; attribute: string; required: boolean }[]): SlotTemplate {
  const slots: Slot[] = proposed.map((p) => ({ id: p.id, attribute: p.attribute, required: p.required, weight: p.required ? GENERATED_SLOT_FACTOR : GENERATED_SLOT_FACTOR * 0.5 }));
  return {
    subject,
    label: subject,
    impact: 'medium',
    halfLifeDays: 365,
    slots: slots.length ? slots : [{ id: 'answer', attribute: 'answer', required: true, weight: GENERATED_SLOT_FACTOR }],
  };
}
