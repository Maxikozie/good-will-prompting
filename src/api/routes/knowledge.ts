import { Router } from 'express';
import { z } from 'zod';
import { buildVerdict, existingAssistant, knowledgeHealth, findExpert, loadOrg, listPages, getPage, getRaw } from '../../core/index';
import { questionSchema, verifyBody, answerBody, healthQuery, expertQuery, topicIdSchema, hashSchema } from '../../core/schemas';
import { mockUser } from '../mock-user';

export function knowledgeRouter() {
  const api = Router();
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

  return api;
}
