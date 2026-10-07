/**
 * `.github/workflows/gate-record.yml` — can this job still compute the PR's diff once the PR is
 * MERGED and its branch is gone?
 *
 * `edited` is in the trigger list because the record lives in the PR body, and the workflow says
 * why: without it, fixing a stale record would need a dummy commit. Two things then combine on a
 * merged PR — the head is reachable from no branch (`delete_branch_on_merge`), and the event
 * resolves to the base branch at the merge commit, so `actions/checkout` builds a local `main` and
 * never asks for `refs/pull/<n>/merge`. `git diff BASE...HEAD` died with a bare
 * `fatal: Invalid symmetric difference expression` and exit 128, before the script's own
 * fail-closed refusal could print. Live instance: lynox-ai/lynox#1577, where correcting the body
 * after the merge turned this required check red.
 *
 * The step's REAL `run:` block is executed here, extracted from the YAML by a parser rather than
 * retyped, against a throwaway git server whose `refs/pull/<n>/head` this file controls. `node` is
 * stubbed so the assertions can read the file list the step actually handed to the script, so a
 * pass has to be the PR's own four-line diff rather than merely a zero exit. (An empty list is
 * not the hazard a review round first claimed it was: `requiredGates` returns `'empty'` and the
 * script refuses outright. The assertion is right; the reason given for it was not.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/gate-record.yml');

type Step = { name?: string; run?: string; env?: Record<string, string> };
const doc = parse(readFileSync(FILE, 'utf8')) as {
  on: { pull_request: { types: string[] } };
  jobs: Record<string, { steps: Step[] }>;
};
const step = (doc.jobs['gate-record']?.steps ?? []).find(
  (s) => s.name === 'Check the record against this head',
);

const NOWHERE = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** The real binary the wrapper below delegates to — resolved, not assumed to be /usr/bin/git. */
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

let root: string;
let server: string;
let serverNoPullRef: string;
let baseSha: string;
let headSha: string;
let orphanSha: string;

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gr-head-'));
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, 'init', '--quiet', '--initial-branch=main');
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'kept.txt'), 'base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '--no-verify', '-m', 'base');
  baseSha = git(work, 'rev-parse', 'HEAD');

  // The PR's own commit, on a branch that will not survive the merge.
  git(work, 'checkout', '--quiet', '-b', 'pr');
  writeFileSync(join(work, 'touched-by-the-pr.txt'), 'head\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '--no-verify', '-m', 'head');
  headSha = git(work, 'rev-parse', 'HEAD');

  // A second root, for the one bare-128 path that is NOT about a missing object.
  git(work, 'checkout', '--quiet', '--orphan', 'orphan');
  git(work, 'rm', '--quiet', '-rf', '.');
  writeFileSync(join(work, 'unrelated.txt'), 'orphan\n');
  git(work, 'add', '-A');
  git(work, 'commit', '--quiet', '--no-verify', '-m', 'orphan');
  orphanSha = git(work, 'rev-parse', 'HEAD');

  server = join(root, 'server.git');
  git(work, 'clone', '--quiet', '--bare', work, server);
  // Exactly the post-merge state: `main` holds the base, the PR branch is DELETED, and the head
  // survives only as the pull ref — which is what GitHub keeps serving.
  git(server, 'update-ref', 'refs/pull/7/head', headSha);
  git(server, 'update-ref', '-d', 'refs/heads/pr');
  git(server, 'update-ref', 'refs/heads/main', baseSha);

  // A second server that serves `main` but NOT the pull ref, so a case can make the fetch
  // itself fail. `git clone` copies refs/heads and refs/tags only, so the pull ref does not
  // come along — which is exactly the state wanted here.
  serverNoPullRef = join(root, 'server-no-pull.git');
  git(root, 'clone', '--quiet', '--bare', server, serverNoPullRef);
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * Clone the server the way `actions/checkout` does for a merged PR — branches only, which no
 * longer include the head — then run the step. `origin` can be pointed elsewhere to prove the
 * fetch did NOT happen, and `allBranches` brings the second root in for the no-merge-base case.
 */
function runStep(
  opts: { base?: string; head?: string; prNumber?: string; origin?: string; allBranches?: boolean } = {},
): { code: number | null; log: string; handed: string | null; gitCalls: string[] } {
  const dir = mkdtempSync(join(root, 'co-'));
  const co = join(dir, 'co');
  const clone = ['clone', '--quiet', '--no-local'];
  if (!opts.allBranches) clone.push('--single-branch', '--branch', 'main');
  git(dir, ...clone, server, co);
  if (opts.allBranches) git(co, 'checkout', '--quiet', 'main');
  // The precondition this whole file rests on. The fetch MUTATES the checkout, so a case that
  // reused a directory would silently describe a different state than it claims.
  if (opts.head === undefined) {
    expect(
      spawnSync('git', ['cat-file', '-e', `${headSha}^{commit}`], { cwd: co }).status,
      'precondition violated: the head is already in the checkout',
    ).not.toBe(0);
  }
  if (opts.origin !== undefined) git(co, 'remote', 'set-url', 'origin', opts.origin);

  // `node` is stubbed so the assertions can read the list the step COMPUTED, not just its exit
  // code. The path comes from argv rather than being assumed — asserting against a hardcoded
  // `/tmp/pr-files.txt` would pin the spelling, not the handover.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const seen = join(dir, 'files-handed-over');
  writeFileSync(
    join(bin, 'node'),
    [
      '#!/bin/sh',
      'prev=""',
      'for a in "$@"; do',
      `  if [ "$prev" = "--files-file" ]; then cp "$a" '${seen}'; fi`,
      '  prev="$a"',
      'done',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'node'), 0o755);

  // `git` is wrapped, not replaced: it records every invocation and then execs the real binary.
  // Without this, "the fetch did not happen" has no witness — the `|| true` on the fetch swallows
  // its failure, so an UNCONDITIONAL fetch against an unreachable origin still exits 0 and looks
  // exactly like not fetching at all. A surviving mutant found that, and the claim it left
  // unwitnessed is the one reviewers care about: this step is inert on an open PR.
  const gitLog = join(dir, 'git-calls');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec ${REAL_GIT} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);

  const r = spawnSync('bash', ['-c', step?.run ?? 'exit 99'], {
    cwd: co,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      PR_BODY: 'irrelevant — the stub never reads it',
      BASE_SHA: opts.base ?? baseSha,
      HEAD_SHA: opts.head ?? headSha,
      PR_NUMBER: opts.prNumber ?? '7',
      PR_AUTHOR: 'someone',
      REPO_PRIVATE: 'false',
    },
  });
  let handed: string | null = null;
  try {
    handed = readFileSync(seen, 'utf8');
  } catch {
    handed = null; // the script was never reached
  }
  let gitCalls: string[] = [];
  try {
    gitCalls = readFileSync(gitLog, 'utf8').split('\n').filter(Boolean);
  } catch {
    gitCalls = [];
  }
  return { code: r.status, log: `${r.stdout}${r.stderr}`, handed, gitCalls };
}

describe('gate-record — the head of a MERGED pull request', () => {
  it('the trigger still includes `edited` — without it this whole repair is pointless', () => {
    expect(doc.on.pull_request.types).toContain('edited');
  });

  it("a head surviving ONLY as refs/pull/<n>/head is fetched, and the diff is the PR's", () => {
    const r = runStep();
    expect(r.code, `the step failed: ${r.log}`).toBe(0);
    // The content, not just the exit code — an exit code cannot tell a correct diff from a
    // merely computable one.
    expect(r.handed).toBe('touched-by-the-pr.txt\n');
    expect(r.gitCalls.some((c) => c.startsWith('fetch') && c.includes('refs/pull/7/head'))).toBe(true);
  });

  it('POSITIVE CONTROL: a head already in the checkout is NOT fetched', () => {
    // This is the claim the step's comment makes — inert on every open PR, where the head
    // arrives with the merge ref — and it is asserted on the CALL, not on the exit code: the
    // `|| true` on the fetch means a fetch that ran and failed exits 0 too, so a code of 0
    // cannot tell the two apart. `origin` is unreachable as a second, independent signal.
    const r = runStep({ head: baseSha, origin: join(root, 'does-not-exist.git') });
    expect(r.code, `the step failed: ${r.log}`).toBe(0);
    expect(r.handed).toBe('');
    // ⚠ The recorder has to be shown ALIVE in this very case. `filter(fetch) === []` is equally
    // satisfied by a wrapper that recorded nothing at all, and a mutation that bypassed the
    // wrapper left this case passing — it survived only by collateral damage from its sibling.
    expect(r.gitCalls.some((c) => c.startsWith('cat-file')), 'the git recorder saw nothing — this case proves nothing').toBe(true);
    expect(r.gitCalls.filter((c) => c.startsWith('fetch')), 'the step fetched although the head was already present').toEqual([]);
  });

  it.each([
    ['a head that is nowhere, not even in the pull ref', { head: NOWHERE }, 'Invalid symmetric difference'],
    ['a missing base', { base: NOWHERE }, 'Invalid symmetric difference'],
    // The path that is NOT about a missing object: both endpoints exist and still cannot be
    // diffed. An earlier draft checked each endpoint for presence and let this one through as a
    // bare `fatal:` with exit 128 — the very failure this guard exists to remove.
    ['two disjoint histories', { allBranches: true, base: undefined, head: undefined }, 'no merge base'],
  ])('%s refuses with this job\'s own message, never a bare 128', (_name, opts, gitSaid) => {
    const o = { ...opts } as Parameters<typeof runStep>[0];
    if (gitSaid === 'no merge base') o.base = orphanSha;
    const r = runStep(o);
    expect(r.code).toBe(1);
    expect(r.log).toContain('::error::gate-record: could not compute this PR\'s diff');
    // The message carries git's OWN reason, so the two cases are told apart by the log rather
    // than by a branch per reason in the step.
    expect(r.log).toContain(gitSaid);
    // Fail CLOSED: the record was never judged.
    expect(r.handed, 'the script ran although the diff could not be computed').toBeNull();
  });

  it('a FETCH that fails still ends in this job\'s message, not in git\'s bare 128', () => {
    // The witness for `|| true` on the fetch. Without it the step aborts under `errexit` with
    // git's own `fatal: couldn't find remote ref` and exit 128 — the exact failure this whole
    // change removes, re-introduced one line higher. A mutation round found it unwitnessed.
    const r = runStep({ origin: serverNoPullRef });
    expect(r.code, `expected the job's own refusal, got: ${r.log}`).toBe(1);
    expect(r.log).toContain("couldn't find remote ref");          // git did try, and failed
    expect(r.log).toContain("::error::gate-record: could not compute this PR's diff");
    expect(r.handed).toBeNull();
  });

  it('a MULTI-LINE git error is flattened into one annotation line', () => {
    // The witness for `tr '\n' ' '`. A blob SHA makes git emit two lines (`error: object … is a
    // blob, not a commit` then `fatal: …`). Both must arrive INSIDE the single `::error::` line:
    // a second line beginning with `::` is how quoted text could forge a workflow command.
    const blob = git(join(root, 'work'), 'rev-parse', `${headSha}:touched-by-the-pr.txt`);
    const r = runStep({ head: blob });
    expect(r.code).toBe(1);
    const annotations = r.log.split('\n').filter((l) => l.includes('::error::gate-record:'));
    expect(annotations, `expected exactly one annotation line, got: ${r.log}`).toHaveLength(1);
    expect(annotations[0]).toContain('is a blob');
    expect(annotations[0]).toContain('fatal:');
    expect(r.handed).toBeNull();
  });

  it('the run block carries no workflow expression — they are substituted even in comments', () => {
    expect(step?.run ?? '').not.toContain('${{');
    expect(step?.env?.['PR_NUMBER']).toBe('${{ github.event.pull_request.number }}');
  });
});
