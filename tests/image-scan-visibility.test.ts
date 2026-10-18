import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * The release image scan can see the OS packages it is meant to judge.
 *
 * trivy reads the installed OS packages from the dpkg status. A hardening step that
 * deletes /var/lib/dpkg leaves those packages on disk and makes them invisible: the
 * scan then reports zero OS findings, which reads exactly like a clean image. So this
 * file holds the precondition instead of trusting the green, next to the threshold the
 * release scan applies.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');
const release = parseYaml(readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8')) as {
  jobs: Record<string, { steps?: { name?: string; uses?: string; with?: Record<string, unknown> }[] }>;
};

/** The Dockerfile's instructions with line continuations joined, comments dropped. */
function instructions(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe('the image Dockerfile', () => {
  const runs = instructions(dockerfile).filter((l) => l.startsWith('RUN '));

  it('never removes the dpkg status a scanner reads the OS packages from', () => {
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect({ run: r, removesDpkgStatus: /\/var\/lib\/dpkg(?![\w-])/.test(r) && /\brm\b/.test(r) }).toMatchObject({ removesDpkgStatus: false });
  });

  it('removes perl through dpkg, so the database says what the image holds', () => {
    expect(runs.some((r) => /^RUN dpkg --purge\b.*\bperl-base\b/.test(r))).toBe(true);
  });

  it('pins every base image by digest', () => {
    const froms = instructions(dockerfile).filter((l) => l.startsWith('FROM '));
    expect(froms.length).toBeGreaterThan(0);
    for (const f of froms) expect(f).toMatch(/@sha256:[0-9a-f]{64}\b/);
  });
});

describe('the release scan', () => {
  it('fails the release on a fixable CRITICAL', () => {
    const scans = Object.values(release.jobs)
      .flatMap((j) => j.steps ?? [])
      .filter((s) => (s.uses ?? '').startsWith('aquasecurity/trivy-action@'));
    expect(scans.length).toBeGreaterThan(0);
    for (const s of scans) expect(s.with).toMatchObject({ 'exit-code': '1', severity: 'CRITICAL', 'ignore-unfixed': true });
  });
});
