import { z } from 'zod';
import { LIMITS } from '../../packages/brain/src/security/limits';
const str = z.string().max(1000);
const nullable = str.nullable();
const country = z.enum(['BE', 'NL']);
const mock = { _mock: str.optional() };
export const ClaimSchema = z.object({ topic: str, value: str, text: str, effective_from: str.optional() }).strict();
export const ClaimsFileSchema = z.object({ ...mock, claims: z.record(z.string().max(200), z.array(ClaimSchema).max(100)) }).strict();
export const PersonSchema = z.object({ id: str, name: str, role: str, team: str, country, active: z.boolean(), email: str }).strict();
export const PeopleFileSchema = z.object({ ...mock, people: z.array(PersonSchema).max(1000), teams: z.array(z.object({ name: str, lead: str, country }).strict()).max(1000) }).strict();
export const OwnershipFileSchema = z.object({ ...mock, ownership: z.array(z.object({ client: str, country, domain: str, owner: str, team: str, lead: str }).strict()).max(1000) }).strict();
export const TopicsFileSchema = z.object({ ...mock, topics: z.array(z.object({ id: str, label: str, keywords: z.array(str).max(100) }).strict()).max(1000) }).strict();
export const QueriesSeedSchema = z.object({ ...mock, queries: z.array(z.object({ ts: str, question: z.string().max(LIMITS.questionChars), asked_by: str }).strict()).max(1000) }).strict();
export const SharePointSchema = z.object({ id: str, title: str, site: str, url: str, content_type: z.enum(['policy', 'wiki', 'email', 'teams']), owner: nullable, owner_team: nullable, created_by: nullable, created: str, modified: str, modified_by: nullable, last_verified: nullable, country: country.nullable(), client: nullable, product: nullable }).strict();
export const TeamsSchema = z.object({ ...mock, id: str, title: str, team: str, channel: str, url: str, country: country.nullable(), client: nullable, product: nullable,
  messages: z.array(z.object({ id: str, from: str, createdDateTime: str, body: z.string().max(LIMITS.documentChars) }).strict()).min(1).max(1000),
}).strict();
export const EmailSchema = z.object({ ...mock, id: str, subject: str, from: str, to: z.array(str).max(100), sentDateTime: str, url: str, country: country.nullable(), client: nullable, product: nullable, body: z.string().max(LIMITS.documentChars) }).strict();
export const PageSchema = z.object({ id: str, title: str, topic: str, owner: nullable, owner_team: nullable, author: nullable, country: country.nullable(), client: nullable, product: nullable,
  source_type: z.enum(['policy', 'wiki', 'email', 'teams']), origin: z.enum(['sharepoint', 'teams', 'outlook', 'internal']), location: str, created: str, last_edited: str, last_verified: nullable,
  status: z.enum(['verified', 'unverified', 'conflict', 'stale', 'orphan', 'superseded']), sources: z.array(str).max(100), supersedes: z.array(str).max(100), superseded_by: nullable.optional(), captured_in: nullable.optional(), claims: z.array(ClaimSchema).max(100), body: z.string().max(LIMITS.documentChars),
}).strict();
export const RawMetaSchema = z.object({ source_id: str, origin: str, original: str, ingested_at: str, ext: z.enum(['md', 'json']) }).strict();
export const TaskSchema = z.object({ id: str, topic: str, topic_label: str, issue: z.enum(['conflict','orphan','stale','gap','unverified','capture']), note: str, country: country.nullable(), client: nullable,
  page_ids: z.array(str).max(100), assignee: str, assignee_reason: str, suggested_claim: nullable, status: z.enum(['open','resolved']), created_at: str, created_by: str, resolved_at: nullable, resolved_by: nullable, verified_claim: nullable, result_page_id: nullable,
}).strict();
export const QuerySchema = z.object({ ts: str, question: z.string().max(LIMITS.questionChars), topic: nullable, country: country.nullable(), client: nullable, best_score: z.number().finite(), asked_by: str }).strict();
export const AssistantFixtureSchema = z.object({ ...mock, assistant: str, topic: str, country: country.optional(), results: z.array(z.object({ id: str, title: str, location: str, snippet: z.string().max(2000), relevance: z.number().min(0).max(1) }).strict()).max(LIMITS.documentsPerCase) }).strict();
