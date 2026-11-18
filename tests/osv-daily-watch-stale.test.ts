/**
 * The daily watch and a stale acceptance. The merge gate fails on an acceptance that no finding
 * names any more (a withdrawn advisory, say); the watch reads the gate's json verdict, and before
 * this it counted only HIGH/CRITICAL, so a stale-only verdict closed the tracking issue and the job
 * stayed green while every pull request went red. These tests run the watch's own lines for it,
 * taken from the workflow, in bash against a verdict file.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const WORKFLOW = fileURLToPath(new URL('../.github/workflows/dep-scan-daily.yml', import.meta.url));

/** The scan step's script: the one step of the `dep-scan` job that reads the verdict file. */
function scanStep(): string {
  const doc = parseYaml(readFileSync(WORKFLOW, 'utf8')) as { jobs: Record<string, { steps: Array<{ run?: string }> }> };
  const steps = doc.jobs['dep-scan']!.steps.filter((s) => (s.run ?? '').includes('/tmp/osv-verdict.json'));
  expect(steps).toHaveLength(1);
  return steps[0]!.run!;
}

/** The lines that count and report stale acceptances, and the block that fails the step on them. */
function staleLines(run: string): string {
  const lines = run.split('\n');
  const count = lines.filter((l) => /^\s*STALE=\$\(/.test(l) || /\(\.unused \/\/ \[\]\)\[\]/.test(l));
  const start = lines.findIndex((l) => /^\s*if \[ "\$\{STALE\}" -gt 0 \]; then/.test(l));
  expect(count, 'the step counts and prints `.unused`').toHaveLength(2);
  expect(start, 'the step fails on a stale count').toBeGreaterThan(-1);
  const end = lines.findIndex((l, i) => i > start && /^\s*fi\s*$/.test(l));
  return [...count, ...lines.slice(start, end + 1)].join('\n');
}

function runWith(verdict: unknown): { status: number | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'osv-watch-'));
  const file = join(dir, 'verdict.json');
  writeFileSync(file, JSON.stringify(verdict));
  const script = `set -euo pipefail\n${staleLines(scanStep()).split('/tmp/osv-verdict.json').join(file)}\n`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10_000 });
  return { status: r.status, stdout: r.stdout };
}

describe('the daily watch reports a stale acceptance instead of closing quietly', () => {
  const BASE = { ok: true, blocking: [], below: [], accepted: [], errors: [] };

  it('fails the step and names each stale entry', () => {
    const r = runWith({ ...BASE, ok: false, unused: ['kit-like GHSA-sta-leen-try1'] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::osv watch: stale acceptance kit-like GHSA-sta-leen-try1');
    expect(r.stdout).toContain('1 stale acceptance(s)');
  });

  it('passes with none, and with a verdict from before the field existed (controls)', () => {
    expect(runWith({ ...BASE, unused: [] }).status).toBe(0);
    expect(runWith(BASE).status).toBe(0);
  });

  it('decides at the end of the step, after the tracking issue is synced, at the step\'s top level', () => {
    const run = scanStep();
    expect(run.lastIndexOf('if [ "${STALE}" -gt 0 ]; then')).toBeGreaterThan(run.lastIndexOf('gh issue'));
    // Not inside a branch of the issue sync: the block and the count sit at the step's own indent,
    // the indent of its first line, so it runs whether or not HIGH/CRITICAL findings were found.
    const lines = run.split('\n');
    const indent = (l: string) => /^ */.exec(l)![0].length;
    const top = indent(lines.find((l) => l.trim() !== '')!);
    expect(indent(lines.find((l) => /^\s*if \[ "\$\{STALE\}" -gt 0 \]; then/.test(l))!)).toBe(top);
    expect(indent(lines.find((l) => /^\s*STALE=\$\(/.test(l))!)).toBe(top);
  });
});
