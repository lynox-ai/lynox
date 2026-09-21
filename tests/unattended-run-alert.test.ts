/**
 * Every unattended workflow reports its outcome to one alert issue.
 *
 * A run started by `schedule`, `repository_dispatch` or `workflow_run` turns no pull
 * request red and leaves `main` green, so its failure is seen only by someone who
 * opens the Actions tab. Each such workflow therefore ends in a job that calls
 * `run-alert.yml`, which opens the workflow's issue on the first red run, updates it
 * while red, and closes it on the next green one.
 *
 * Membership is decided by the TRIGGER, read from the parsed workflow, and never by
 * looking for the alert job: a sweep that picks its members from the text it checks
 * passes when the check is deleted. The named anchors below cannot drop out of the
 * set silently, and every other workflow with such a trigger joins it on its own.
 *
 * Issues here are public. The body is therefore pinned whole below: the workflow
 * name, two counters and the run link, and nothing a failing job could put there.
 *
 * The script half is tested by running the real `run:` block from `run-alert.yml`
 * against a stub `gh`, so what is pinned is what the job does, not what it says.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const ALERT_FILE = 'run-alert.yml';
const ALERT_USES = `./.github/workflows/${ALERT_FILE}`;
const UNATTENDED = ['schedule', 'repository_dispatch', 'workflow_run'];

/** Anchors: workflows known to be unattended. The sweep may grow; these may not vanish. */
const KNOWN_MEMBERS = ['dep-scan-daily.yml'];

type Job = {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  steps?: { run?: string; env?: Record<string, string> }[];
};
type Workflow = { name?: string; on?: unknown; concurrency?: unknown; jobs?: Record<string, Job> };

function workflowFiles(): string[] {
  return readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();
}

function load(file: string): Workflow {
  return parse(readFileSync(join(DIR, file), 'utf-8')) as Workflow;
}

function triggersOf(doc: Workflow): string[] {
  const on = doc.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return on !== null && typeof on === 'object' ? Object.keys(on) : [];
}

function isUnattended(doc: Workflow): boolean {
  return triggersOf(doc).some((t) => UNATTENDED.includes(t));
}

/** `${{ x }}` and `x` compare equal, whitespace ignored. */
function norm(v: unknown): unknown {
  return typeof v === 'string' ? v.replace(/\s+/g, '').replace(/^\$\{\{(.*)\}\}$/, '$1') : v;
}

/** What is missing for this workflow's outcome to reach its alert issue. */
function alertGaps(doc: Workflow): string[] {
  const jobs = doc.jobs ?? {};
  const callers = Object.entries(jobs).filter(([, j]) => j.uses === ALERT_USES);
  if (callers.length !== 1) return [`${callers.length} jobs call ${ALERT_USES}; expected exactly one`];
  const [id, job] = callers[0] as [string, Job];
  const gaps: string[] = [];
  const needs = typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []);
  const unwatched = Object.keys(jobs).filter((k) => k !== id && !needs.includes(k));
  if (unwatched.length > 0) gaps.push(`the alert job does not wait for: ${unwatched.join(', ')}`);
  if (norm(job.if) !== 'always()') gaps.push('the alert job needs `if: always()`, or a failed job skips it');
  if (norm(job.with?.['results']) !== 'toJSON(needs.*.result)') {
    gaps.push('the alert job must pass `results: ${{ toJSON(needs.*.result) }}`');
  }
  if (job.permissions?.['issues'] !== 'write') gaps.push('the alert job needs `permissions: issues: write`');
  // Two overlapping runs of one workflow could both find no issue and open two.
  // Workflow-level concurrency keeps them apart; run-alert.yml deliberately has no
  // job-level group, because a newer pending alert would cancel an older one.
  if (doc.concurrency === undefined) gaps.push('the workflow needs workflow-level `concurrency`');
  return gaps;
}

describe('unattended workflows — who must report', () => {
  it('every workflow file parses, so none can fail before its first job', () => {
    // A workflow that does not parse starts no job, so its alert job cannot fire
    // either. Parsing here keeps that failure in the pull request.
    const files = workflowFiles();
    expect(files.length).toBeGreaterThan(KNOWN_MEMBERS.length);
    for (const f of files) {
      expect(() => load(f), `${f} must parse`).not.toThrow();
      expect(load(f).jobs, `${f} must declare jobs`).toBeTypeOf('object');
    }
  });

  it('the parser refuses the shape that once reached a workflow file', () => {
    // A plain `run:` scalar containing ": " is a nested mapping YAML rejects;
    // GitHub then reports the run as failed with no job at all.
    expect(() => parse('jobs:\n  a:\n    steps:\n      - run: echo a: b\n')).toThrow();
  });

  it('finds the known unattended workflows by their triggers', () => {
    const members = workflowFiles().filter((f) => isUnattended(load(f)));
    for (const known of KNOWN_MEMBERS) expect(members, `${known} lost its unattended trigger`).toContain(known);
  });

  it('every unattended workflow reports its outcome to its alert issue', () => {
    const members = workflowFiles().filter((f) => f !== ALERT_FILE && isUnattended(load(f)));
    expect(members.length).toBeGreaterThanOrEqual(KNOWN_MEMBERS.length);
    for (const f of members) expect(alertGaps(load(f)), f).toEqual([]);
  });

  it('every unattended workflow has a name no other workflow shares', () => {
    // The issue is found by title, and the title is the workflow's name: two
    // workflows sharing one would share an issue and close each other's.
    const names = workflowFiles().map((f) => load(f).name);
    for (const f of workflowFiles().filter((x) => x !== ALERT_FILE && isUnattended(load(x)))) {
      const name = load(f).name;
      expect(name, `${f} needs a name`).toBeTypeOf('string');
      expect(names.filter((n) => n === name), `${f}: "${name}" is not unique`).toHaveLength(1);
    }
  });

  it('the alert workflow is only ever called, never triggered on its own', () => {
    expect(triggersOf(load(ALERT_FILE))).toEqual(['workflow_call']);
  });

  it('the alert workflow grants exactly `issues: write`, once, at the top', () => {
    // Its job adds no block of its own: a called workflow can only narrow what
    // its caller grants, and whether a called JOB may re-widen past its own
    // workflow's block is not documented. Without this grant the first red run
    // would fail inside the alert, unseen, which is the defect this exists for.
    const doc = load(ALERT_FILE) as Workflow & { permissions?: unknown };
    expect(doc.permissions).toEqual({ issues: 'write' });
    expect(((doc.jobs ?? {})['sync'] as Job).permissions).toBeUndefined();
  });
});

describe('unattended workflows — the check catches each gap', () => {
  const ok = (): Workflow => ({
    on: { schedule: [{ cron: '0 0 * * *' }] },
    concurrency: { group: 'nightly' },
    jobs: {
      work: {},
      more: { needs: 'work' },
      alert: {
        needs: ['work', 'more'],
        if: 'always()',
        permissions: { issues: 'write' },
        uses: ALERT_USES,
        with: { results: '${{ toJSON(needs.*.result) }}' },
      },
    },
  });
  const alertOf = (d: Workflow): Job => (d.jobs as Record<string, Job>)['alert'] as Job;

  it('a complete alert job passes', () => {
    expect(alertGaps(ok())).toEqual([]);
  });

  it('a workflow with no alert job is caught', () => {
    const d = ok();
    delete (d.jobs as Record<string, Job>)['alert'];
    expect(alertGaps(d)).toHaveLength(1);
  });

  it('a job the alert does not wait for is caught', () => {
    const d = ok();
    alertOf(d).needs = ['work'];
    expect(alertGaps(d).join()).toContain('more');
  });

  it('an alert job that a failure would skip is caught', () => {
    const d = ok();
    delete alertOf(d).if;
    expect(alertGaps(d).join()).toContain('always()');
  });

  it('an alert job that passes something other than the job results is caught', () => {
    const d = ok();
    alertOf(d).with = { results: '${{ needs.work.result }}' };
    expect(alertGaps(d).join()).toContain('results');
  });

  it('an alert job without the issues grant is caught', () => {
    const d = ok();
    alertOf(d).permissions = { contents: 'read' };
    expect(alertGaps(d).join()).toContain('issues');
  });

  it('a workflow whose runs may overlap is caught', () => {
    const d = ok();
    delete d.concurrency;
    expect(alertGaps(d).join()).toContain('concurrency');
  });
});

// ── the script ───────────────────────────────────────────────────────────────

const step = (((load(ALERT_FILE).jobs ?? {})['sync'] as Job).steps ?? [])[0] ?? {};
const SCRIPT = step.run ?? '';
const WORKFLOW = 'Nightly thing';
const TITLE = `Unattended run is red: ${WORKFLOW}`;
const RUN_URL = 'https://github.com/o/r/actions/runs/42';

/** The whole body, fixed. Anything a later change adds to it fails here. */
function expectedBody(phases: number, reds: number): string {
  return [
    `<!-- run-alert phases=${phases} reds=${reds} -->`,
    `The unattended workflow **${WORKFLOW}** is red.`,
    '',
    `- red phases so far: ${phases}`,
    `- red runs in the current phase: ${reds}`,
    `- latest red run: ${RUN_URL}`,
    '',
    'This issue is reused for every red phase of this workflow. It closes itself on the next green run and reopens on the next red one. Many phases mean the workflow flaps; a long current phase means it is stuck.',
  ].join('\n');
}

/** What the REST issues endpoint returns; pull requests share it and carry `pull_request`. */
type Issue = { number: number; title: string; state: 'open' | 'closed'; body: string | null; pull_request?: object };
const issue = (state: Issue['state'], phases: number | string, reds: number | string, number = 7, title = TITLE): Issue => ({
  number,
  title,
  state,
  body: `<!-- run-alert phases=${phases} reds=${reds} -->\nwhatever a human left here`,
});

const LOOKUP = 'repos/o/r/issues?labels=run-alert&state=all&per_page=100';
const GH_STUB = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args[1] === '${LOOKUP}') process.stdout.write(process.env.GH_STUB_ISSUES);
`;

/** Run the real step script the way the runner does, against a recording `gh`. */
function runAlert(results: string[] | string, issues: Issue[] = []): { code: number; calls: string[][]; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'run-alert-'));
  const log = join(dir, 'gh.log');
  writeFileSync(join(dir, 'gh'), GH_STUB, { mode: 0o755 });
  const env = {
    PATH: `${dir}:${process.env['PATH'] ?? ''}`,
    HOME: dir,
    GH_STUB_LOG: log,
    GH_STUB_ISSUES: JSON.stringify(issues),
    GH_TOKEN: 'unused',
    GH_REPO: 'o/r',
    WORKFLOW,
    RESULTS: typeof results === 'string' ? results : JSON.stringify(results, null, 2),
    RUN_URL,
  };
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', SCRIPT], { env, encoding: 'utf-8', stdio: 'pipe' });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? -1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const calls = existsSync(log)
    ? readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
    : [];
  rmSync(dir, { recursive: true, force: true });
  return { code, calls, out };
}

const writes = (calls: string[][]): string[][] =>
  calls.filter((c) => c[0] === 'issue' && ['create', 'edit', 'reopen', 'close', 'comment'].includes(c[1] ?? ''));
const flag = (call: string[] | undefined, name: string): string | undefined => {
  const i = (call ?? []).indexOf(name);
  return i < 0 ? undefined : call?.[i + 1];
};

describe('run-alert — what the job does to the issue', () => {
  it('the step reads everything through env, and only these five values', () => {
    expect(SCRIPT).not.toContain('${{');
    expect(Object.keys(step.env ?? {}).sort()).toEqual(['GH_REPO', 'GH_TOKEN', 'RESULTS', 'RUN_URL', 'WORKFLOW']);
  });

  it('the first red run opens the issue with the fixed body', () => {
    const r = runAlert(['success', 'failure']);
    expect(r.code, r.out).toBe(0);
    const w = writes(r.calls);
    expect(w.map((c) => c[1])).toEqual(['create']);
    expect(flag(w[0], '--title')).toBe(TITLE);
    expect(flag(w[0], '--label')).toBe('run-alert');
    expect(flag(w[0], '--body')).toBe(expectedBody(1, 1));
  });

  it('a further red run only updates the counters — no reopen, no comment', () => {
    const r = runAlert(['failure'], [issue('open', 2, 3)]);
    expect(r.code, r.out).toBe(0);
    const w = writes(r.calls);
    expect(w.map((c) => c.slice(0, 3))).toEqual([['issue', 'edit', '7']]);
    expect(flag(w[0], '--body')).toBe(expectedBody(2, 4));
  });

  it('a red run after a green one reopens the same issue and starts a new phase', () => {
    const r = runAlert(['failure'], [issue('closed', 2, 3)]);
    expect(r.code, r.out).toBe(0);
    const w = writes(r.calls);
    expect(w.map((c) => c.slice(0, 3))).toEqual([['issue', 'edit', '7'], ['issue', 'reopen', '7']]);
    expect(flag(w[0], '--body')).toBe(expectedBody(3, 1));
    expect(flag(w[1], '--comment')).toBe(`Red again: ${RUN_URL}`);
  });

  it('a green run closes an open issue', () => {
    const r = runAlert(['success', 'skipped'], [issue('open', 2, 3)]);
    expect(r.code, r.out).toBe(0);
    const w = writes(r.calls);
    expect(w.map((c) => c.slice(0, 3))).toEqual([['issue', 'close', '7']]);
    expect(flag(w[0], '--comment')).toBe(`Green again: ${RUN_URL} (after 3 red run(s) in this phase)`);
  });

  it('a green run leaves a closed issue, or no issue, alone', () => {
    expect(writes(runAlert(['success'], [issue('closed', 2, 3)]).calls)).toEqual([]);
    expect(writes(runAlert(['success']).calls)).toEqual([]);
  });

  it('a timed-out job counts as red — it reports `cancelled`, not `failure`', () => {
    // Measured on real runs that hit their timeout: the job concluded `cancelled`.
    // An earlier version of this script read that as "no evidence" and stayed
    // silent on exactly the hung job an alert exists for.
    for (const results of [['cancelled', 'skipped'], ['success', 'cancelled']]) {
      const w = writes(runAlert(results).calls);
      expect(w.map((c) => c[1]), JSON.stringify(results)).toEqual(['create']);
    }
  });

  it('a run in which every job was skipped changes nothing and calls nothing', () => {
    for (const results of [['skipped'], ['skipped', 'skipped'], []]) {
      const r = runAlert(results, [issue('open', 2, 3)]);
      expect(r.code, `${JSON.stringify(results)}: ${r.out}`).toBe(0);
      expect(r.calls, JSON.stringify(results)).toEqual([]);
    }
  });

  it('the lookup reads the REST list, not the lagging search index', () => {
    // `gh issue list --label` goes through search, which can miss an issue created
    // moments earlier and so open a second one.
    const r = runAlert(['failure'], [issue('open', 1, 1)]);
    const reads = r.calls.filter((c) => c[0] === 'api' || (c[0] === 'issue' && c[1] === 'list'));
    expect(reads).toEqual([['api', LOOKUP]]);
  });

  it('a pull request with the same title is not taken for the issue', () => {
    const pr = { ...issue('open', 4, 4, 5), pull_request: {} };
    const w = writes(runAlert(['failure'], [pr]).calls);
    expect(w.map((c) => c[1])).toEqual(['create']);
    expect(w.flat()).not.toContain('5');
  });

  it('counters a person edited to a leading zero are still read as decimal', () => {
    const r = runAlert(['failure'], [issue('open', '08', '09')]);
    expect(r.code, r.out).toBe(0);
    expect(flag(writes(r.calls)[0], '--body')).toBe(expectedBody(8, 10));
  });

  it("another workflow's issue is never touched", () => {
    const other = issue('open', 5, 5, 9, 'Unattended run is red: Other thing');
    const w = writes(runAlert(['failure'], [other]).calls);
    expect(w.map((c) => c[1])).toEqual(['create']);
    expect(w.flat()).not.toContain('9');
  });

  it('a lookup that may be cut short refuses instead of opening a second issue', () => {
    const many = Array.from({ length: 100 }, (_, i) => issue('closed', 1, 1, 100 + i, `Unattended run is red: W${i}`));
    const r = runAlert(['failure'], many);
    expect(r.code).not.toBe(0);
    expect(writes(r.calls)).toEqual([]);
  });

  it('results that are not a job-result list fail the job rather than guess', () => {
    const r = runAlert('not json');
    expect(r.code).not.toBe(0);
    expect(r.calls).toEqual([]);
  });
});
