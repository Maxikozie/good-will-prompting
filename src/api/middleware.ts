import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { ResourceError } from '../../packages/brain/src/security/errors';
import { TaskError } from '../core/index';

export function securityHeaders(isProd: boolean): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // Dev needs Vite's inline HMR preamble, so the strict CSP applies to the production build only.
    if (isProd) res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    next();
  };
}

// Simple fixed-window rate limit per client IP for the API (no extra dependency).
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 300;
export function createRateLimit(): RequestHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  return function rateLimit(req: Request, res: Response, next: NextFunction) {
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
  };
}

// Never leak stack traces; validation errors come back as a readable 400.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ResourceError) return res.status(err.status).json({ error: err.message });
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Invalid input', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
  if (err instanceof TaskError) return res.status(409).json({ error: err.message });
  const status = (err as { status?: number })?.status;
  if (err instanceof SyntaxError || status === 400) return res.status(400).json({ error: 'Malformed JSON' });
  if (status === 413) return res.status(413).json({ error: 'Request too large' });
  console.error('[api] unexpected error', err);
  res.status(500).json({ error: 'Internal error' });
}
