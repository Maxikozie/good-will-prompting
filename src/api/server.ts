import express, { type NextFunction, type Request, type Response } from 'express';
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
import { ROOT } from '../core/util';

const PORT = Number(process.env.PORT ?? 5173);
const HOST = process.env.HOST ?? '127.0.0.1';
const isProd = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');

ensureVault();

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Dev needs Vite's inline HMR preamble, so the strict CSP applies to the production build only.
  if (isProd) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
});

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

api.get('/assistant', (req, res) => {
  const q = questionSchema.parse(req.query.q);
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
api.post('/transcribe', express.raw({ type: (req) => /^audio\//.test(String(req.headers['content-type'] ?? '')), limit: '10mb' }), async (req, res) => {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim();
  if (!/^audio\/[a-z0-9.+-]{1,40}$/.test(type)) return res.status(415).json({ error: 'Send audio (e.g. audio/webm)' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: 'Recording is empty or too short' });
  const key = process.env.ELEVENLABS_API_KEY;
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
    const r = await fetch(STT_URL, { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) {
      console.error(`[api] speech-to-text failed with HTTP ${r.status}`);
      return res.status(502).json({ error: 'Speech-to-text failed. Type your question instead.' });
    }
    const data = (await r.json()) as { text?: unknown };
    const text = typeof data.text === 'string' ? data.text.trim().slice(0, 500) : '';
    if (!text) return res.status(422).json({ error: "Didn't catch that, try again" });
    res.json({ text });
  } catch {
    console.error('[api] speech-to-text request error');
    res.status(502).json({ error: 'Speech-to-text unavailable. Type your question instead.' });
  }
});

// Demo helper: rebuild the vault from data/mock between recording takes. Disabled in production.
api.post('/demo/reset', (_req, res) => {
  if (isProd) return res.status(404).json({ error: 'Not found' });
  res.json(resetVault());
});

api.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Never leak stack traces; validation errors come back as a readable 400.
function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  if (err instanceof TaskError) return res.status(409).json({ error: err.message });
  const status = (err as { status?: number })?.status;
  if (err instanceof SyntaxError || status === 400) return res.status(400).json({ error: 'Malformed JSON' });
  if (status === 413) return res.status(413).json({ error: 'Request too large' });
  console.error('[api] unexpected error', err);
  res.status(500).json({ error: 'Internal error' });
}
api.use(errorHandler);

app.use('/api', rateLimit, express.json({ limit: '64kb', strict: true }), api);
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
