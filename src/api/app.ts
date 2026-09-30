import express from 'express';
import { LIMITS } from '../../packages/brain/src/security/limits';
import { apiRouter, type ApiOptions } from './routes';
import { createRateLimit, errorHandler, securityHeaders } from './middleware';

/** Assemble HTTP middleware without opening a port or initializing the vault. */
export function createApp(options: ApiOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders(options.isProd));
  app.use('/api', createRateLimit(), express.json({ limit: LIMITS.jsonBodyBytes, strict: true }), apiRouter(options));
  app.use(errorHandler);
  return app;
}
