import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Corpus boundary (SPEC §1, brain-rules invariant 1): evidence/** and reference/** never import each other,
// and neither may import pipeline/** (which sees both). test/boundary.test.ts enforces the same thing on disk
// (and also catches dynamic import()/require).
const forbid = (dirs, why) => ({
  'no-restricted-imports': [
    'error',
    { patterns: [{ group: dirs.flatMap((d) => [`**/${d}`, `**/${d}/**`]), message: why }] },
  ],
});

export default defineConfig(
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
  {
    files: ['src/evidence/**/*.ts'],
    rules: forbid(['reference', 'pipeline'], 'evidence/** must not import reference/** or pipeline/** (corpus boundary)'),
  },
  {
    files: ['src/reference/**/*.ts'],
    rules: forbid(['evidence', 'pipeline'], 'reference/** must not import evidence/** or pipeline/** (corpus boundary)'),
  },
);
