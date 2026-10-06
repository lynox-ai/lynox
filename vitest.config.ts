import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults, defineConfig } from 'vitest/config';
import { ONLINE_TESTS_GLOB, onlineTestsSkipReason } from './scripts/vitest-online-opt-in.js';

// Printed, not silent: a run that leaves the online tests out says so and says how to include them.
const onlineSkip = onlineTestsSkipReason(process.env);
if (onlineSkip !== null) console.log(onlineSkip);

export default defineConfig({
  // The svelte compiler lets a test import a Svelte 5 rune module (`*.svelte.ts`,
  // e.g. the chat store) and drive its logic, instead of matching its source
  // text. It only transforms `.svelte` and `.svelte.*` files, so every other test
  // is compiled exactly as before. Modules compile in server mode here: `$state`
  // is a plain variable without a deep proxy, `$effect` is compiled away, and
  // `$derived` re-evaluates on every read instead of caching — tests exercise the
  // logic, not the reactivity.
  plugins: [svelte()],
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(onlineSkip !== null ? [ONLINE_TESTS_GLOB] : [])],
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
