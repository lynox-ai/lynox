/**
 * The canary image build reads the build cache that staging.yml writes on every main
 * push, and writes none of its own.
 *
 * Unscoped, a canary looked in the default scope and found nothing: every stage ran
 * again, the whisper compile and the model download included. Writing a scope of its
 * own does not fix that either, because the repo's gha cache sits at its size limit
 * and a further scope evicts the release and staging layers.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

interface Step { uses?: string; with?: Record<string, unknown> }
interface Job { steps?: Step[]; strategy?: { matrix?: { include?: Array<Record<string, string>> } } }
interface Workflow { jobs: Record<string, Job> }

const read = (name: string): Workflow =>
  parseYaml(readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), 'utf-8')) as Workflow;

const buildSteps = (wf: Workflow): Step[] =>
  Object.values(wf.jobs).flatMap((j) => j.steps ?? []).filter((s) => s.uses?.startsWith('docker/build-push-action@'));

describe('canary image build cache', () => {
  const canary = buildSteps(read('canary-build.yml'));

  it('has the scan build and the push build', () => {
    expect(canary).toHaveLength(2);
  });

  it('reads the staging amd64 scope in both builds', () => {
    for (const step of canary) expect(step.with?.['cache-from']).toBe('type=gha,scope=staging-amd64');
  });

  it('writes no cache', () => {
    for (const step of canary) expect(step.with).not.toHaveProperty('cache-to');
  });

  it('builds on amd64, the one platform that scope holds', () => {
    for (const step of canary) expect(step.with).not.toHaveProperty('platforms');
  });

  it('reads a scope staging.yml actually writes', () => {
    const staging = read('staging.yml');
    const writes = buildSteps(staging).map((s) => String(s.with?.['cache-to'] ?? ''));
    const arches = Object.values(staging.jobs).flatMap((j) => j.strategy?.matrix?.include ?? []).map((i) => i['arch_tag']);
    expect(arches).toContain('amd64');
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toBe('type=gha,mode=max,scope=staging-${{ matrix.arch_tag }}');
  });
});
