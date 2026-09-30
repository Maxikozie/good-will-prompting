import express, { type Express } from 'express';
import path from 'node:path';
import { ROOT } from '../core/util';

/** Attach the same dashboard through Vite in development or static assets in production. */
export async function attachWeb(app: Express, isProd: boolean) {
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
}
