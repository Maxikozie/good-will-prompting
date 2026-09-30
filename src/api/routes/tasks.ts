import { Router } from 'express';
import { loadTasks, flagForOwner, resolveTask } from '../../core/index';
import { flagBody, taskIdSchema, resolveBody } from '../../core/schemas';
import { mockUser } from '../mock-user';

export function tasksRouter() {
  const api = Router();
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

  return api;
}
