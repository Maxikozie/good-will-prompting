import { ensureVault } from '../core/index';
import { ENV } from '../core/util';
import { createApp } from './app';
import { attachWeb } from './web';

async function start() {
  const PORT = ENV.PORT ?? 5173;
  const HOST = ENV.HOST ?? '127.0.0.1';
  const isProd = ENV.NODE_ENV === 'production' || process.argv.includes('--prod');
  ensureVault();
  const app = createApp({ isProd, speechApiKey: ENV.ELEVENLABS_API_KEY });
  await attachWeb(app, isProd);
  app.listen(PORT, HOST, () => {
    console.log(`\n  TrustLayer dashboard + API → http://localhost:${PORT}\n  MCP server: npm run mcp (stdio)\n`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
