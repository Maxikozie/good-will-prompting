import { Router } from 'express';
import { z } from 'zod';
import { boundedValue } from '../../../packages/brain/src/security/input';
import { resetVault } from '../../core/index';
import { knowledgeRouter } from './knowledge';
import { tasksRouter } from './tasks';
import { speechRouter } from './speech';

export interface ApiOptions { isProd: boolean; speechApiKey?: string }

export function apiRouter({ isProd, speechApiKey }: ApiOptions) {
  const api = Router();
  api.use((req, _res, next) => {
    boundedValue(req.body);
    if (!['/assistant', '/health', '/expert'].includes(req.path)) z.object({}).strict().parse(req.query);
    next();
  });

  api.use(knowledgeRouter());
  api.use(tasksRouter());
  api.use(speechRouter(speechApiKey));

  // Demo helper: rebuild the vault from data/mock between recording takes. Disabled in production.
  api.post('/demo/reset', (req, res) => {
    if (isProd) return res.status(404).json({ error: 'Not found' });
    z.object({}).strict().parse(req.body ?? {});
    res.json(resetVault());
  });

  api.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return api;
}
