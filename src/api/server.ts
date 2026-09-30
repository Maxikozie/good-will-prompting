import { readResponseJson } from '../../packages/brain/src/llm/http';
import { LIMITS } from '../../packages/brain/src/security/limits';
import { boundedValue } from '../../packages/brain/src/security/input';
import { ResourceError } from '../../packages/brain/src/security/errors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { z } from 'zod';
import {
  buildVerdict,
  ensureVault,
  existingAssistant,
  findExpert,
  flagForOwner,
  getPage,
  getRaw,
  knowledgeHealth,
  listPages,
  loadOrg,
  loadTasks,
  resetVault,
  resolveTask,
  TaskError,
} from '../core/index';
import {
  answerBody,
  expertQuery,
  flagBody,
  hashSchema,
  healthQuery,
  questionSchema,
  resolveBody,
  taskIdSchema,
  topicIdSchema,
  verifyBody,
} from '../core/schemas';
import { ROOT, ENV } from '../core/util';

const PORT = ENV.PORT ?? 5173;
const HOST = ENV.HOST ?? '127.0.0.1';
const isProd = ENV.NODE_ENV === 'production' || process.argv.includes('--prod');

ensureVault();

const app = express();
app.disable('x-powered-by');
app.use(helmet({
  // Dev needs Vite's inline HMR preamble and websocket, so the strict CSP applies to the production build only.
  contentSecurityPolicy: isProd
    ? {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
      }
    : false,
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
}));

// Simple fixed-window rate limit per client IP for the API (no extra dependency).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 300;
const hits = new Map<string, { count: number; reset: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? 'unknown';
  const t = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < t) {
    if (hits.size > 10_000) hits.clear();
    hits.set(key, { count: 1, reset: t + RATE_WINDOW_MS });
    return next();
  }
  if (++h.count > RATE_MAX) {
    res.setHeader('Retry-After', String(Math.ceil((h.reset - t) / 1000)));
    return res.status(429).json({ error: 'Too many requests' });
  }
  next();
}

// MOCK auth: the dashboard sends the signed-in demo user in x-mock-user. No real authentication.
function mockUser(req: Request): string | undefined {
  const u = req.header('x-mock-user');
  return u && /^[a-z0-9][a-z0-9.-]{0,60}$/.test(u) ? u : undefined;
}

const api = express.Router();
api.use((req, _res, next) => {
  boundedValue(req.body);
  if (!['/assistant', '/health', '/expert'].includes(req.path)) z.object({}).strict().parse(req.query);
  next();
});

api.get('/assistant', (req, res) => {
  const { q } = z.object({ q: questionSchema }).strict().parse(req.query);
  res.json(existingAssistant(q));
});

api.post('/verify', (req, res) => {
  const b = verifyBody.parse(req.body);
  res.json(buildVerdict(b.question, b.context, { sources: b.sources, askedBy: mockUser(req) }));
});

api.post('/answer', (req, res) => {
  const b = answerBody.parse(req.body);
  res.json(buildVerdict(b.question, b.context, { askedBy: mockUser(req) }));
});

api.get('/health', (req, res) => {
  res.json(knowledgeHealth(healthQuery.parse(req.query)));
});

api.get('/tasks', (_req, res) => {
  res.json(loadTasks());
});

api.post('/tasks', (req, res) => {
  const b = flagBody.parse(req.body);
  res.status(201).json(flagForOwner({ ...b, created_by: b.created_by ?? mockUser(req) }));
});

api.post('/tasks/:id/resolve', (req, res) => {
  const id = taskIdSchema.parse(req.params.id);
  const b = resolveBody.parse(req.body);
  res.json(resolveTask({ task_id: id, ...b }));
});

api.get('/expert', (req, res) => {
  const q = expertQuery.parse(req.query);
  res.json(findExpert(q.topic, { country: q.country, client: q.client }));
});

api.get('/people', (_req, res) => {
  res.json(loadOrg().people);
});

api.get('/pages', (_req, res) => {
  res.json(listPages().map(({ body: _body, ...meta }) => meta));
});

api.get('/pages/:id', (req, res) => {
  const page = getPage(topicIdSchema.parse(req.params.id));
  if (!page) return res.status(404).json({ error: 'Page not found' });
  res.json(page);
});

api.get('/raw/:hash', (req, res) => {
  const raw = getRaw(hashSchema.parse(req.params.hash));
  if (!raw) return res.status(404).json({ error: 'Raw source not found' });
  res.json(raw);
});

// Voice input: browser audio → ElevenLabs Speech-to-Text (Scribe). The API key stays on the server.
const STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const STT_MAX = 20; // transcriptions per client per minute (they cost credits)
const sttHits = new Map<string, { count: number; reset: number }>();
api.post('/transcribe', express.raw({ type: (req) => /^audio\//.test(String(req.headers['content-type'] ?? '')), limit: LIMITS.audioBodyBytes }), async (req, res) => {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
  if (!/^audio\/[a-z0-9.+-]{1,40}$/.test(type)) return res.status(415).json({ error: 'Send audio (e.g. audio/webm)' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: 'Recording is empty or too short' });
  const key = ENV.ELEVENLABS_API_KEY;
  if (!key) return res.status(503).json({ error: 'Voice input is not configured (ELEVENLABS_API_KEY missing). Type your question instead.' });

  const ip = req.ip ?? 'unknown';
  const t = Date.now();
  const h = sttHits.get(ip);
  if (!h || h.reset < t) sttHits.set(ip, { count: 1, reset: t + 60_000 });
  else if (++h.count > STT_MAX) return res.status(429).json({ error: 'Too many voice requests, wait a minute' });

  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('tag_audio_events', 'false');
  form.append('file', new Blob([new Uint8Array(req.body)], { type }), `question.${type.split('/')[1].replace(/[^a-z0-9]/g, '') || 'webm'}`);
  try {
    const r = await fetch(STT_URL, { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(LIMITS.speechTimeoutMs) });
    if (!r.ok) {
      console.error(`[api] speech-to-text failed with HTTP ${r.status}`);
      return res.status(502).json({ error: 'Speech-to-text failed. Type your question instead.' });
    }
    const data = z.object({
      text: z.string().max(LIMITS.documentChars), language_code: z.string().max(20).optional(), language_probability: z.number().min(0).max(1).optional(), transcription_id: z.string().max(200).optional(),
      words: z.array(z.object({ text: z.string().max(1000), start: z.number(), end: z.number(), type: z.enum(['word', 'spacing', 'audio_event']), speaker_id: z.string().nullable().optional(), logprob: z.number().optional() }).strict()).max(100_000).optional(),
    }).strict().parse(await readResponseJson(r));
    const text = typeof data.text === 'string' ? data.text.trim().slice(0, LIMITS.questionChars) : '';
    if (!text) return res.status(422).json({ error: "Didn't catch that, try again" });
    res.json({ text });
  } catch {
    console.error('[api] speech-to-text request error');
    res.status(502).json({ error: 'Speech-to-text unavailable. Type your question instead.' });
  }
});

// Demo helper: rebuild the vault from data/mock between recording takes. Disabled in production.
api.post('/demo/reset', (req, res) => {
  if (isProd) return res.status(404).json({ error: 'Not found' });
  z.object({}).strict().parse(req.body ?? {});
  res.json(resetVault());
});

api.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Never leak stack traces; validation errors come back as a readable 400.
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ResourceError) return res.status(err.status).json({ error: err.message });
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  if (err instanceof TaskError) return res.status(409).json({ error: err.message });
  const status = (err as { status?: number })?.status;
  if (err instanceof SyntaxError || status === 400) return res.status(400).json({ error: 'Malformed JSON' });
  if (status === 413) return res.status(413).json({ error: 'Request too large' });
  console.error('[api] unexpected error', err);
  res.status(500).json({ error: 'Internal error' });
}
api.use(errorHandler);

app.use('/api', rateLimit, express.json({ limit: LIMITS.jsonBodyBytes, strict: true }), api);
app.use(errorHandler);

async function start() {
  const webRoot = path.join(ROOT, 'web');
  if (isProd) {
    const dist = path.join(webRoot, 'dist');
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    // Dev: Vite runs inside this Express process, so one command serves the dashboard + API on one port.
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: webRoot,
      configFile: path.join(webRoot, 'vite.config.ts'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }
  app.listen(PORT, HOST, () => {
    console.log(`\n  TrustLayer dashboard + API → http://localhost:${PORT}\n  MCP server: npm run mcp (stdio)\n`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
