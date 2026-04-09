import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/performance/**/*.bench.ts'],
    testTimeout: 120_000,
    pool: 'forks',
    benchmark: {
      outputJson: 'tests/performance/results.json',
    },
  },
});
