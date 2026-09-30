import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  buildVerdict,
  ensureVault,
  findExpert,
  flagForOwner,
  knowledgeHealth,
  resolveTask,
  TaskError,
  type HealthReport,
  type Verdict,
} from '../core/index';
import {
  contextSchema,
  countrySchema,
  inputSourceSchema,
  issueSchema,
  personIdSchema,
  questionSchema,
  taskIdSchema,
  topicIdSchema,
} from '../core/schemas';

// TrustLayer MCP server (stdio). stdout is the MCP protocol channel: log to stderr only.

ensureVault();

const server = new McpServer(
  { name: 'trustlayer', version: '0.1.0' },
  {
    instructions:
      'TrustLayer tells you which SD Worx knowledge source to trust. Before answering an HR/payroll question from documents, ' +
      'call verify_sources with the sources you found (or trusted_answer if you have none). Report the recommended answer, ' +
      'its verification state and any conflict. If sources conflict or the answer is unverified, offer to flag_for_owner. ' +
      'Owners close the loop with resolve. knowledge_health shows conflicts, orphans, stale pages and gaps; find_expert says who to ask.',
  },
);

function verdictText(v: Verdict): string {
  const lines = [
    `**Trusted answer** (${v.confidence} confidence${v.verified ? ', VERIFIED' : ', not verified'}): ${v.answer}`,
    `Basis: ${v.answer_basis}`,
  ];
  if (v.owner_to_ask) lines.push(`Owner to ask: ${v.owner_to_ask.name} <${v.owner_to_ask.email}> (${v.owner_reason})`);
  for (const c of v.conflicts) {
    lines.push('', `**Conflict:** ${c.summary}`, ...c.sides.map((s) => `- ${s.value}: "${s.title}" (trust ${s.score})`));
  }
  lines.push('', '**Sources** (trust score 0-100, reasons first):');
  for (const s of v.sources) {
    const tag = s.from_assistant ? '' : ' [added by TrustLayer]';
    lines.push(`- ${s.score} ${s.level.toUpperCase()} · "${s.title}"${tag}${s.flags.length ? ` · ${s.flags.join(', ')}` : ''}`);
    for (const r of s.reasons.slice(0, 3)) lines.push(`    - ${r}`);
  }
  if (v.actions.length) lines.push('', '**Next steps:**', ...v.actions.map((a) => `- ${a}`));
  if (v.open_task) lines.push('', `Open fix task: ${v.open_task.id} (assigned to ${v.open_task.assignee})`);
  if (v.topic) lines.push('', `topic id: ${v.topic.id} · context: ${JSON.stringify(v.context)}`);
  return lines.join('\n');
}

function healthText(h: HealthReport): string {
  const lines = [
    `**Knowledge health: ${h.score}/100** · ${h.pages} live pages, ${h.verified} verified, ${h.open_tasks} open fix tasks`,
    `Tiles: ${h.tiles.map((t) => `${t.key} ${t.score}`).join(' · ')}`,
  ];
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push('', `**${title}** (${items.length})`, ...items.map((i) => `- ${i}`));
  };
  section('Conflicts', h.conflicts.map((c) => `${c.summary} · topic id: ${c.topic}${c.open_task_id ? ` · task ${c.open_task_id}` : ''}`));
  section('Orphans', h.orphans.map((o) => `"${o.title}" (${o.page_id}): ${o.detail}${o.open_task_id ? ` · task ${o.open_task_id}` : ''}`));
  section('Stale', h.stale.map((o) => `"${o.title}" (${o.page_id}): ${o.detail}${o.open_task_id ? ` · task ${o.open_task_id}` : ''}`));
  section('Unverified', h.unverified.map((o) => `"${o.title}" (${o.page_id}): ${o.detail}`));
  section('Gaps', h.gaps.map((g) => `"${g.question}" asked ${g.times_asked}x, best trust ${g.best_score} · topic id: ${g.topic}${g.open_task_id ? ` · task ${g.open_task_id}` : ''}`));
  return lines.join('\n');
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function guard(fn: () => ToolResult): ToolResult {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof TaskError || err instanceof z.ZodError ? err.message : 'Internal error';
    if (!(err instanceof TaskError)) console.error('[trustlayer-mcp]', err);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
}

server.registerTool(
  'verify_sources',
  {
    title: 'Verify sources',
    description:
      'THE trust layer. Give it a question plus the sources another assistant/search returned (ids, titles or URLs). ' +
      'Returns per-source trust scores with reasons (owner, freshness, country/client scope, authority, corroboration), ' +
      'detected conflicts, the recommended source, a one-line trusted answer, confidence and the owner to ask. ' +
      'Also adds in-scope knowledge the other assistant missed (e.g. Teams chats).',
    inputSchema: {
      question: questionSchema.describe('The question being answered'),
      sources: z.array(inputSourceSchema).max(20).describe('Sources returned by the existing assistant: {id?, hash?, title?, location?, snippet?}'),
      context: contextSchema.optional().describe('Optional scope; detected from the question when omitted'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ question, sources, context }) => guard(() => ok(verdictText(buildVerdict(question, context, { sources, askedBy: 'mcp' })))),
);

server.registerTool(
  'trusted_answer',
  {
    title: 'Trusted answer',
    description:
      'Search the TrustLayer knowledge vault directly and return the same verdict as verify_sources: which source to trust and why, ' +
      'conflicts, a one-line answer, confidence and the owner to ask. Use when you have no sources of your own.',
    inputSchema: {
      question: questionSchema.describe('The HR / payroll question, e.g. "Sunday overtime premium for Nordwind Retail in Belgium?"'),
      context: contextSchema.optional().describe('Optional scope; detected from the question when omitted'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ question, context }) => guard(() => ok(verdictText(buildVerdict(question, context, { askedBy: 'mcp' })))),
);

server.registerTool(
  'knowledge_health',
  {
    title: 'Knowledge health radar',
    description:
      'The knowledge health radar: overall health score, per-team and per-country tiles, and lists of conflicts, orphaned (ownerless) pages, ' +
      'stale pages, unverified changes and knowledge gaps (questions nobody could answer with a trusted source). Use the returned ids with flag_for_owner.',
    inputSchema: {
      country: countrySchema.optional().describe('Only this country'),
      team: z.string().trim().max(100).optional().describe('Only pages owned by this team, e.g. "Payroll BE – Retail"'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ country, team }) => guard(() => ok(healthText(knowledgeHealth({ country, team })))),
);

server.registerTool(
  'flag_for_owner',
  {
    title: 'Flag for owner',
    description:
      'Create a fix task for the accountable owner (or the team lead if the page is orphaned). topic = a topic id (from a verdict or knowledge_health, ' +
      'e.g. "sunday-overtime-premium") or a page id for page-level issues. Idempotent: returns the open task if one exists.',
    inputSchema: {
      topic: topicIdSchema.describe('Topic id or page id'),
      issue: issueSchema.describe('conflict | orphan | stale | gap | unverified | capture'),
      note: z.string().trim().min(1).max(1000).describe('Why this needs fixing, e.g. the customer question that hit the conflict'),
      context: contextSchema.optional().describe('Scope for topic-level tasks, e.g. {country: "BE", client: "Nordwind Retail"}'),
    },
  },
  async ({ topic, issue, note, context }) =>
    guard(() => {
      const { task, created } = flagForOwner({ topic, issue, note, context, created_by: 'mcp' });
      return ok(
        `${created ? 'Created' : 'Already open:'} task ${task.id} → ${task.assignee} (${task.assignee_reason})\n` +
          `Topic: ${task.topic_label} · issue: ${task.issue} · pages: ${task.page_ids.join(', ') || 'none'}\n` +
          (task.suggested_claim ? `Suggested claim to verify: ${task.suggested_claim}` : ''),
      );
    }),
);

server.registerTool(
  'resolve',
  {
    title: 'Resolve fix task',
    description:
      'Owner resolves a fix task with the verified claim. The wiki page becomes "verified" (last_verified = now), losing sources are marked superseded, ' +
      'chat messages are captured into the page, and the next question gets the verified answer. Only the assignee or their team lead may resolve.',
    inputSchema: {
      task_id: taskIdSchema.describe('Task id from flag_for_owner / knowledge_health'),
      verified_claim: z.string().trim().min(5).max(1000).describe('The correct, owner-verified answer in one or two sentences'),
      resolved_by: personIdSchema.describe('Person id of the owner resolving it, e.g. "lotte.peeters"'),
    },
  },
  async ({ task_id, verified_claim, resolved_by }) =>
    guard(() => {
      const { task, page, superseded } = resolveTask({ task_id, verified_claim, resolved_by });
      return ok(
        `Resolved ${task.id}. Page "${page.title}" (${page.id}) is now ${page.status}, verified ${page.last_verified} by ${resolved_by}.\n` +
          `Superseded: ${superseded.join(', ') || 'none'}\nVerified claim: ${verified_claim}`,
      );
    }),
);

server.registerTool(
  'find_expert',
  {
    title: 'Find expert',
    description: 'Who owns or last answered this topic (Connect): the accountable owner plus people with evidence (pages they own, answers in Teams/email).',
    inputSchema: {
      topic: z.string().trim().min(2).max(300).describe('Topic id or a free-text question'),
      context: contextSchema.optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ topic, context }) =>
    guard(() => {
      const r = findExpert(topic, context);
      const lines = r.experts.map(
        (e) => `- ${e.person.name} <${e.person.email}>, ${e.person.role}, ${e.person.team}: ${e.reason}` + (e.evidence.length ? ` (evidence: ${e.evidence.map((x) => `"${x.title}"`).join(', ')})` : ''),
      );
      return ok([`Experts for ${r.topic ?? topic}:`, ...(lines.length ? lines : ['- nobody found']), r.note ? `Note: ${r.note}` : ''].join('\n'));
    }),
);

await server.connect(new StdioServerTransport());
console.error('[trustlayer-mcp] ready on stdio');
