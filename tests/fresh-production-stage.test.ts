/**
 * Staging and canary images build their production stage fresh on the scan build, as
 * release.yml does.
 *
 * A cached apt layer keeps the Debian package versions of whichever build first wrote
 * it: its cache key does not change when Debian publishes a fix. The scan build runs the
 * production stage with `no-cache-filters`, and the push build after it reuses that
 * builder's fresh layers, so what is scanned is what ships.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

interface Step { name?: string; uses?: string; with?: Record<string, unknown> }
interface Workflow { jobs: Record<string, { steps?: Step[] }> }

const file = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf-8');
const lastStage = (): string => {
  const stages = [...file('Dockerfile').matchAll(/^FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1]!);
  return stages[stages.length - 1]!;
};

describe.each(['staging.yml', 'canary-build.yml'])('%s', (name) => {
  const wf = parseYaml(file(`.github/workflows/${name}`)) as Workflow;
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
  const builds = steps.filter((s) => s.uses?.startsWith('docker/build-push-action@'));
  const scan = builds.filter((s) => s.with?.['load'] === true);
  // staging.yml pushes by digest through `outputs`, the canary with `push: true`: the push build is the other one.
  const push = builds.filter((s) => s.with?.['load'] !== true);

  it('has one scan build and one push build, the scan first', () => {
    expect(scan).toHaveLength(1);
    expect(push).toHaveLength(1);
    expect(steps.indexOf(scan[0]!)).toBeLessThan(steps.indexOf(push[0]!));
  });

  it('builds the Dockerfile\'s last stage fresh on the scan build', () => {
    expect(lastStage()).toBe('production');
    expect(scan[0]!.with?.['no-cache-filters']).toBe(lastStage());
  });

  it('lets the push build reuse the scan build\'s layers instead of building again', () => {
    expect(push[0]!.with).not.toHaveProperty('no-cache-filters');
    expect(push[0]!.with).not.toHaveProperty('no-cache');
    expect(push[0]!.with?.['cache-from']).toBe(scan[0]!.with?.['cache-from']);
    // One builder in the job that builds: a second one would start the push build empty.
    const job = Object.values(wf.jobs).find((j) => (j.steps ?? []).includes(scan[0]!))!;
    expect(job.steps).toContain(push[0]);
    expect((job.steps ?? []).filter((s) => s.uses?.startsWith('docker/setup-buildx-action@'))).toHaveLength(1);
    // What keys the layers is the same in both builds.
    for (const key of ['context', 'platforms', 'build-args', 'file', 'target']) {
      expect(push[0]!.with?.[key], key).toEqual(scan[0]!.with?.[key]);
    }
  });
});
