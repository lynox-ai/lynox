/**
 * The production dispatch waits for a human approval.
 *
 * `dispatch-pro-release` sends the event that deploys the private control plane and the website
 * to production. It carries `environment: production`, whose one protection rule is a required
 * reviewer. The key was removed once before (2026-04-23) and for five months a comment downstream
 * kept promising a gate that no longer existed. A key removed again should be a decision someone
 * makes on purpose, so this test pins it.
 *
 * It pins only what this repository contains. The environment's rule itself lives in the
 * repository SETTINGS (one required reviewer, admin bypass allowed), which no checkout can see.
 *
 * Second assertion: no step creates a Deployment by hand. With the environment on the job,
 * GitHub creates the Deployment object itself. A manual record step next to it books every
 * release twice; one existed while the environment was absent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/release.yml');

type Step = { uses?: string; with?: { script?: string } };
type Job = { needs?: string | string[]; environment?: string | { name?: string }; steps?: Step[] };

const job = (parse(readFileSync(FILE, 'utf8')) as { jobs: Record<string, Job> }).jobs['dispatch-pro-release'];

describe('release.yml — dispatch-pro-release', () => {
  it('exists', () => {
    expect(job).toBeDefined();
  });

  it('runs in the `production` environment, i.e. waits for its required reviewer', () => {
    const env = job?.environment;
    expect(typeof env === 'string' ? env : env?.name).toBe('production');
  });

  it('still waits on the published release (images + npm), so only the prod deploy is held', () => {
    const needs = typeof job?.needs === 'string' ? [job.needs] : job?.needs ?? [];
    expect([...needs].sort()).toEqual(['docker-manifest', 'npm']);
  });

  it('records no Deployment by hand — GitHub does that for the environment', () => {
    const scripts = (job?.steps ?? []).map((s) => s.with?.script ?? '');
    expect(scripts.filter((s) => s.includes('createDeployment'))).toEqual([]);
  });
});
