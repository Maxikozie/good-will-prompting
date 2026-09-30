import type { Request } from 'express';

// MOCK auth: the dashboard sends the signed-in demo user in x-mock-user. No real authentication.
export function mockUser(req: Request): string | undefined {
  const u = req.header('x-mock-user');
  return u && /^[a-z0-9][a-z0-9.-]{0,60}$/.test(u) ? u : undefined;
}

