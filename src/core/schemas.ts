import { z } from 'zod';
import { PAGE_ID_RE, PERSON_ID_RE, TASK_ID_RE, HASH_RE } from './util';

// Shared zod schemas: every MCP tool input and API body is validated with these.

export const countrySchema = z.enum(['BE', 'NL']);

export const contextSchema = z
  .object({
    country: countrySchema.optional().describe('Country the question is about: BE or NL'),
    client: z.string().trim().min(1).max(100).optional().describe('Client company, e.g. "Nordwind Retail"'),
    product: z.string().trim().min(1).max(100).optional().describe('SD Worx product area, e.g. "Pay"'),
  })
  .strict();

export const questionSchema = z.string().trim().min(3).max(500);

export const inputSourceSchema = z
  .object({
    id: z.string().trim().max(120).optional(),
    hash: z.string().regex(HASH_RE).optional(),
    title: z.string().trim().max(300).optional(),
    location: z.string().trim().max(500).optional(),
    snippet: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((s) => s.id || s.hash || s.title || s.location, { message: 'A source needs at least an id, hash, title or location' });

export const topicIdSchema = z.string().trim().regex(PAGE_ID_RE, 'Use a page id or topic id (lowercase, dashes)');
export const taskIdSchema = z.string().trim().regex(TASK_ID_RE, 'Invalid task id');
export const personIdSchema = z.string().trim().regex(PERSON_ID_RE, 'Invalid person id');
export const hashSchema = z.string().regex(HASH_RE);
export const issueSchema = z.enum(['conflict', 'orphan', 'stale', 'gap', 'unverified', 'capture']);

export const verifyBody = z.object({ question: questionSchema, sources: z.array(inputSourceSchema).max(20), context: contextSchema.optional() }).strict();
export const answerBody = z.object({ question: questionSchema, context: contextSchema.optional() }).strict();
export const flagBody = z
  .object({
    topic: topicIdSchema,
    issue: issueSchema,
    note: z.string().trim().min(1).max(1000),
    context: contextSchema.optional(),
    created_by: personIdSchema.optional(),
  })
  .strict();
export const resolveBody = z.object({ verified_claim: z.string().trim().min(5).max(1000), resolved_by: personIdSchema }).strict();
export const healthQuery = z.object({ country: countrySchema.optional(), team: z.string().trim().max(100).optional() }).strict();
export const expertQuery = z
  .object({ topic: z.string().trim().min(2).max(300), country: countrySchema.optional(), client: z.string().trim().max(100).optional() })
  .strict();
