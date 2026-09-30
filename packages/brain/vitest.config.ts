import { defineConfig } from 'vitest/config';

// Several test files start their own embedded Postgres (PGlite, WASM): give hooks room when they all boot at once.
export default defineConfig({ test: { hookTimeout: 60_000, testTimeout: 30_000 } });
