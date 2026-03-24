/**
 * Online tests: DAG Planner with real Haiku API calls.
 *
 * Cost: ~$0.003 total for all tests in this file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { planDAG } from '../../src/core/dag-planner.js';
import { getApiKey, hasApiKey, HAIKU } from './setup.js';

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: DAG Planner', () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = getApiKey();
  });

  it('decomposes a goal into pipeline steps', async () => {
    const result = await planDAG('Build a Node.js CLI tool that lists files in a directory', {
      apiKey,
      model: HAIKU,
      maxSteps: 5,
    });

    expect(result).not.toBeNull();
    expect(result!.steps.length).toBeGreaterThanOrEqual(2);
    expect(result!.steps.length).toBeLessThanOrEqual(5);
    expect(result!.reasoning).toBeTruthy();
    expect(result!.estimatedCost).toBeGreaterThan(0);

    // Each step should have required fields
    for (const step of result!.steps) {
      expect(step.id).toBeTruthy();
      expect(step.task).toBeTruthy();
      expect(['haiku', 'sonnet', 'opus']).toContain(step.model);
    }
  }, 20_000);

  it('respects project context in planning', async () => {
    const result = await planDAG('Add user authentication', {
      apiKey,
      model: HAIKU,
      maxSteps: 5,
      projectContext: 'SvelteKit app with PostgreSQL, Lucia v3 for auth. TypeScript strict mode.',
    });

    expect(result).not.toBeNull();
    expect(result!.steps.length).toBeGreaterThanOrEqual(2);

    // At least one step should reference the context
    const allTasks = result!.steps.map(s => s.task.toLowerCase()).join(' ');
    expect(allTasks).toMatch(/svelte|lucia|postgres|auth/i);
  }, 20_000);

  it('creates dependencies between steps', async () => {
    const result = await planDAG('Research competitors, then write a comparison report', {
      apiKey,
      model: HAIKU,
      maxSteps: 5,
    });

    expect(result).not.toBeNull();

    // At least one step should depend on another
    const hasInputFrom = result!.steps.some(
      s => Array.isArray(s.input_from) && s.input_from.length > 0,
    );
    expect(hasInputFrom).toBe(true);
  }, 20_000);

  it('assigns cost-efficient models per step', async () => {
    const result = await planDAG('Read a config file and validate its format', {
      apiKey,
      model: HAIKU,
      maxSteps: 4,
    });

    expect(result).not.toBeNull();

    // Simple read-only tasks should use haiku (cheapest)
    const haikuSteps = result!.steps.filter(s => s.model === 'haiku');
    expect(haikuSteps.length).toBeGreaterThan(0);
  }, 20_000);
});
