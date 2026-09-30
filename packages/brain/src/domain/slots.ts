import { z } from 'zod';
import { Impact, UnitSchema, ValueTypeSchema } from './enums';

// SPEC §4: the expected answer shape per subject (slots/<subject>.yaml). Gaps are measured against it.
export const SlotSchema = z.object({
  id: z.string().min(1).max(60),
  attribute: z.string().min(1).max(60),
  required: z.boolean(),
  weight: z.number().min(0).max(1),
  valueType: ValueTypeSchema.optional(),
  unit: UnitSchema.optional(),
});
export type Slot = z.infer<typeof SlotSchema>;

export const SlotTemplateSchema = z.object({
  subject: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  impact: Impact,
  slots: z.array(SlotSchema).min(1).max(30),
  halfLifeDays: z.number().positive(),
});
export type SlotTemplate = z.infer<typeof SlotTemplateSchema>;
