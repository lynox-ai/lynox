import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults, defineConfig } from 'vitest/config';
import { ONLINE_TESTS_GLOB, onlineTestsSkipReason } from './scripts/vitest-online-opt-in.js';
import { rejectSvelteModules } from './scripts/vitest-node-project-guard.js';

// Printed, not silent: a run that leaves the online tests out says so and says how to include them.
const onlineSkip = onlineTestsSkipReason(process.env);
if (onlineSkip !== null) console.log(onlineSkip);

const EXCLUDE = [...configDefaults.exclude, ...(onlineSkip !== null ? [ONLINE_TESTS_GLOB] : [])];

/** Tests that drive a Svelte 5 rune module (`*.svelte.ts`, e.g. the chat store). */
const BROWSER_COMPILE_TESTS = 'packages/*/src/**/*.svelte.test.ts';

// What both projects run with. Spelled out per project rather than inherited with
// `extends: true`, which loads this file again for every project and so runs the root
// `globalSetup` once per project: its temp-root accounting nests and its count goes wrong.
const SHARED = { testTimeout: 10_000, pool: 'forks' as const };

export default defineConfig({
  test: {
    // Runs once per run, here at the root: the projects below do not inherit it.
    globalSetup: ['./scripts/vitest-global-setup.ts'],
    // Two forks for the whole run, both projects together. Left unset, vitest starts one fork per
    // core but one, and a machine running several suites fills up. It stays here at the root:
    // a project's own value wins over `--maxWorkers`, so set per project it could not be lowered
    // or raised from the command line any more.
    maxWorkers: 2,
    projects: [
      {
        // No Svelte module loads here: it would compile for the server. A test that reaches one,
        // directly or through a helper, fails with a message naming the fix (`*.svelte.test.ts`).
        plugins: [rejectSvelteModules()],
        test: {
          ...SHARED,
          name: 'node',
          include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
          exclude: [...EXCLUDE, BROWSER_COMPILE_TESTS],
        },
      },
      {
        // The svelte compiler lets a test import a Svelte 5 rune module and drive its logic,
        // instead of matching its source text. These tests run in jsdom, which makes the svelte
        // plugin compile for the client, as the browser runs it. In the default (node) environment
        // it compiles for the server, where a `$state` list is the array it was given; in the
        // browser it is a proxy, and writes through it do not reach that array, so code that leans
        // on the two being one array passes there and fails here.
        // `svelte-compile-mode.svelte.test.ts` checks this project really compiles for the client.
        plugins: [svelte()],
        test: {
          ...SHARED,
          name: 'browser-compile',
          include: [BROWSER_COMPILE_TESTS],
          exclude: EXCLUDE,
          environment: 'jsdom',
          setupFiles: ['./scripts/vitest-browser-compile-setup.ts'],
        },
      },
    ],
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
