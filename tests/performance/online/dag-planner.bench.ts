/**
 * Online Benchmark: DAG planner
 *
 * Measures Haiku-based DAG decomposition for different goal complexities.
 * Each call costs ~$0.001-$0.003.
 *
 * Run: pnpm bench:online
 */
import { bench, describe, beforeAll } from 'vitest';
import { planDAG } from '../../../src/core/dag-planner.js';
import { getApiKey, hasApiKey } from '../../online/setup.js';

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: DAG Planner', () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = getApiKey();
  });

  bench('simple goal (2-3 steps)', async () => {
    await planDAG('Read the README.md and summarize the project structure.', {
      apiKey,
      maxSteps: 5,
    });
  }, { iterations: 3, warmupIterations: 1 });

  bench('medium goal (4-6 steps)', async () => {
    await planDAG('Analyze the codebase for security issues, write a report, and create fix PRs.', {
      apiKey,
      maxSteps: 8,
    });
  }, { iterations: 3, warmupIterations: 1 });

  bench('complex goal with context (6-10 steps)', async () => {
    await planDAG(
      'Build a dashboard showing daily active users, revenue, and churn rate. Include data fetching, chart components, and responsive layout.',
      {
        apiKey,
        maxSteps: 12,
        projectContext: 'SvelteKit app with Tailwind CSS, PostgreSQL database, TypeScript strict mode.',
      },
    );
  }, { iterations: 2, warmupIterations: 0 });
});
