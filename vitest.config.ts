import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The svelte compiler lets a test import a Svelte 5 rune module (`*.svelte.ts`,
  // e.g. the chat store) and drive it, instead of matching its source text. It
  // only transforms `.svelte` and `.svelte.*` files, so every other test is
  // compiled exactly as before.
  plugins: [svelte()],
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    globalSetup: ['./scripts/vitest-global-setup.ts'],
    testTimeout: 10_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/core/**', 'src/tools/**', 'src/orchestrator/**', 'src/cli/**', 'src/integrations/**'],
      exclude: ['**/*.test.ts', '**/*.bench.ts'],
      thresholds: {
        lines: 65,
        functions: 60,
        branches: 50,
        statements: 65,
      },
    },
  },
});
