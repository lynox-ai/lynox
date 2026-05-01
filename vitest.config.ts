import { defineConfig } from 'vitest/config';

export default defineConfig({
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
