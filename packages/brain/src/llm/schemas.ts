import { z } from 'zod';
import { ModalitySchema, PolaritySchema, QualifiersSchema, QuestionTypeSchema, ScopeSchema, TemporalSchema } from '../domain';

// What the model is allowed to say. Anything status/score/winner related is deliberately absent (invariant 3).
const dotted = z.string().min(1).max(200).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'use a lowercase dotted id like "leave.small_leave.own_marriage"');
const snake = z.string().min(1).max(60).regex(/^[a-z][a-z0-9_]*$/, 'use snake_case');

export const IntakeOutputSchema = z.object({
  subject: dotted,
  matchesKnownSubject: z.boolean(),
  scope: ScopeSchema,
  questionType: QuestionTypeSchema,
  proposedSlots: z.array(z.object({ id: snake, attribute: snake, required: z.boolean() }).strict()).max(8),
}).strict();
export type IntakeOutput = z.infer<typeof IntakeOutputSchema>;

export const ExtractedClaimSchema = z.object({
  quote: z.string().min(1).max(300),
  subject: dotted,
  attribute: snake,
  valueRaw: z.string().min(1).max(300),
  qualifiers: QualifiersSchema,
  temporal: TemporalSchema.default({}),
  polarity: PolaritySchema,
  modality: ModalitySchema,
  confidence: z.number().min(0).max(1),
}).strict();
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;

export const ExtractOutputSchema = z.object({ claims: z.array(ExtractedClaimSchema).max(40) }).strict();
export type ExtractOutput = z.infer<typeof ExtractOutputSchema>;

export const RelationSchema = z.enum(['agree', 'contradict', 'refine', 'supersede', 'scope_disjoint', 'unrelated']);
export type Relation = z.infer<typeof RelationSchema>;

export const RelationOutputSchema = z.object({
  relation: RelationSchema,
  explanation: z.string().min(1).max(300),
  /** For "refine": the more specific claim; for "supersede": the newer claim that replaces the other. Otherwise null. */
  direction: z.enum(['a', 'b']).nullable().default(null),
}).strict();
export type RelationOutput = z.infer<typeof RelationOutputSchema>;

export const ComposeOutputSchema = z.object({ sentences: z.array(z.object({ factId: z.string().min(1).max(200), text: z.string().min(1).max(600) }).strict()).max(30) }).strict();
export type ComposeOutput = z.infer<typeof ComposeOutputSchema>;
