import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Every required check name has exactly ONE run per head.
 *
 * ci.yml used to carry `paths-ignore: ['docs/**']`, and a stub workflow (also named `CI`) re-emitted
 * the required job names for docs-only pull requests. On a MIXED pull request both workflows
 * started, so `test`, `docker-scan` and `gitleaks` were each reported twice under one name: once for
 * real, once as a stub job skipped by its condition — which GitHub reports as success — in no
 * guaranteed order (measured on six mixed PRs; on one the skipped twin finished after the real
 * run). Required checks added later (`smoke`, `greenmail`) were missing from the stub, so a
 * docs-only PR could not report them at all.
 *
 * Now one workflow decides once (`detect`), and the expensive required jobs read its answer.
 */
const WF_DIR = '.github/workflows/';
const SCRIPT = 'scripts/ci-docs-only.sh';
type Job = { name?: string; needs?: string | string[]; if?: string };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };
const load = (f: string) => parseYaml(readFileSync(WF_DIR + f, 'utf8')) as Workflow;
const workflows = () => readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
const triggers = (on: unknown): string[] => (typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === 'object' ? Object.keys(on) : []);

/** Check names reported on a pull request by more than one job: name → list of `file:job`. */
function twinNames(files: Array<[string, Workflow]>): Record<string, string[]> {
  const byName: Record<string, string[]> = {};
  for (const [f, wf] of files) {
    if (!triggers(wf.on).some((t) => t === 'pull_request' || t === 'pull_request_target')) continue;
    for (const [id, job] of Object.entries(wf.jobs ?? {})) (byName[job.name ?? id] ??= []).push(`${f}:${id}`);
  }
  return Object.fromEntries(Object.entries(byName).filter(([, v]) => v.length > 1));
}

const FAIL_CLOSED_IF = "${{ !cancelled() && (needs.detect.result != 'success' || needs.detect.outputs.docs-only != 'true') }}";
const GATED = ['docker-scan', 'greenmail', 'smoke'];

describe('one run per required check name', () => {
  it('no two pull-request jobs report the same check name — and the sweep sees a twin when there is one', () => {
    // positive control on the sweep itself
    const twin: Workflow = { on: { pull_request: { paths: ['docs/**'] } }, jobs: { test: { if: 'x' } } };
    expect(twinNames([['ci.yml', load('ci.yml')], ['stub.yml', twin]])).toHaveProperty('test');
    expect(twinNames(workflows().map((f) => [f, load(f)] as [string, Workflow]))).toEqual({});
  });

  it('ci.yml starts on every push to main and every pull request — no path filter', () => {
    const on = load('ci.yml').on as Record<string, Record<string, unknown> | null>;
    for (const ev of ['push', 'pull_request']) {
      expect(Object.keys(on)).toContain(ev);
      expect(on[ev]?.['paths'], ev).toBeUndefined();
      expect(on[ev]?.['paths-ignore'], ev).toBeUndefined();
    }
  });

  it('the expensive required jobs wait for detect and RUN when detect fails', () => {
    const jobs = load('ci.yml').jobs ?? {};
    for (const id of GATED) {
      expect(jobs[id]?.needs, id).toBe('detect');
      expect(jobs[id]?.if, id).toBe(FAIL_CLOSED_IF);
    }
    // gitleaks and test run on every change, docs-only included (test carries the osv gate, which
    // tests/osv-workflow-pin.test.ts keeps unconditional); detect has nothing to wait for
    for (const id of ['gitleaks', 'test']) {
      expect(jobs[id]?.if, id).toBeUndefined();
      expect(jobs[id]?.needs, id).toBeUndefined();
    }
    expect(jobs['detect']?.if).toBeUndefined();
    // every other job of ci.yml is named here — a new one has to be placed on purpose
    expect(Object.keys(jobs).sort()).toEqual(['detect', 'gitleaks', 'test', ...GATED].sort());
  });
});

describe('ci-docs-only.sh', () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-docs-only-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();
    git('init', '-q');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'README.md'), 'r\n');
    writeFileSync(join(dir, 'docs/a.md'), 'a\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    const commit = (files: Record<string, string>) => {
      git('checkout', '-q', base);
      for (const [f, c] of Object.entries(files)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), c); }
      git('add', '-A'); git('commit', '-qm', 'change', '--allow-empty');
      return git('rev-parse', 'HEAD');
    };
    const run = (b: string, h: string) => spawnSync('bash', [join(process.cwd(), SCRIPT), b, h], { cwd: dir, encoding: 'utf8' });
    return { base, commit, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it('true only when every changed file is under docs/', () => {
    const r = repo();
    try {
      expect(r.run(r.base, r.commit({ 'docs/a.md': 'b\n', 'docs/sub/c.md': 'c\n' })).stdout.trim()).toBe('docs-only=true');
      expect(r.run(r.base, r.commit({ 'docs/a.md': 'b\n', 'src/x.ts': 'x\n' })).stdout.trim()).toBe('docs-only=false');
      expect(r.run(r.base, r.commit({ 'README.md': 'changed\n' })).stdout.trim()).toBe('docs-only=false');
      // a path that merely STARTS with "docs" is not under docs/
      expect(r.run(r.base, r.commit({ 'docs-site/x.md': 'x\n' })).stdout.trim()).toBe('docs-only=false');
    } finally { r.cleanup(); }
  });

  it('every doubt answers false: empty change, first push, no base', () => {
    const r = repo();
    try {
      expect(r.run(r.base, r.commit({})).stdout.trim()).toBe('docs-only=false');
      expect(r.run('0000000000000000000000000000000000000000', r.base).stdout.trim()).toBe('docs-only=false');
      expect(r.run('', r.base).stdout.trim()).toBe('docs-only=false');
    } finally { r.cleanup(); }
  });

  it('a base git cannot resolve fails the script, so detect fails and the gated jobs run', () => {
    const r = repo();
    try {
      const res = r.run('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', r.base);
      expect(res.status).not.toBe(0);
      expect(res.stdout).not.toContain('docs-only=true');
    } finally { r.cleanup(); }
  });
});
