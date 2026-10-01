/**
 * The production dispatch waits for a human approval.
 *
 * `dispatch-pro-release` sends the event that deploys the private control plane to production.
 * It carries `environment: production`, whose one protection rule is a required reviewer. The key was removed once before (2026-04-23) and for five months a comment downstream
 * kept promising a gate that no longer existed. A key removed again should be a decision someone
 * makes on purpose, so this test pins it.
 *
 * It pins only what this repository contains. The environment's rule itself lives in the
 * repository SETTINGS (one required reviewer, admin bypass allowed), which no checkout can see.
 *
 * The gate only means something if the dispatch itself lives in that job: a dispatch step moved
 * to any other job would leave every environment assertion green while nothing waits. So the
 * test also requires that EVERY step sending the event sits in a job with the environment.
 *
 * Last assertion: no step creates a Deployment by hand. With the environment on the job,
 * GitHub creates the Deployment object itself. A manual record step next to it books every
 * release twice; one existed while the environment was absent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/release.yml');

type Step = { run?: string; uses?: string; with?: { script?: string } };
type Job = { needs?: string | string[]; environment?: string | { name?: string }; steps?: Step[] };

const jobs = (parse(readFileSync(FILE, 'utf8')) as { jobs: Record<string, Job> }).jobs;
const job = jobs['dispatch-pro-release'];
const envName = (j: Job | undefined): string | undefined =>
  typeof j?.environment === 'string' ? j.environment : j?.environment?.name;
/** Everything a step executes, as text: shell, inline script, and the action it uses. */
const stepText = (s: Step): string => `${s.run ?? ''}\n${s.with?.script ?? ''}\n${s.uses ?? ''}`;

describe('release.yml — dispatch-pro-release', () => {
  it('exists', () => {
    expect(job).toBeDefined();
  });

  it('runs in the `production` environment, i.e. waits for its required reviewer', () => {
    expect(envName(job)).toBe('production');
  });

  it('still waits on the published release (images + npm), so only the prod deploy is held', () => {
    const needs = typeof job?.needs === 'string' ? [job.needs] : job?.needs ?? [];
    expect([...needs].sort()).toEqual(['docker-manifest', 'npm']);
  });

  it('every step that dispatches to lynox-pro sits in a job with the production environment', () => {
    const dispatching = Object.entries(jobs).flatMap(([name, j]) =>
      (j.steps ?? []).filter((s) => /lynox-pro\/dispatches|engine-release-published/.test(stepText(s))).map(() => name));
    expect(dispatching.length, 'no dispatch found at all — the test would be vacuous').toBeGreaterThan(0);
    expect(dispatching.filter((name) => envName(jobs[name]) !== 'production')).toEqual([]);
  });

  it('records no Deployment by hand, in any form — GitHub does that for the environment', () => {
    const manual = (job?.steps ?? []).map(stepText)
      .filter((t) => /createDeployment|\/deployments\b|deployment-action|actions\/deployment/i.test(t));
    expect(manual).toEqual([]);
  });
});
