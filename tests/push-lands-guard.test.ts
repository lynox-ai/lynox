/**
 * `scripts/push-lands-guard.mjs` — a push to a branch whose pull request is already merged or
 * closed lands nowhere, while `git push` reports success.
 *
 * Three layers, because each can fail on its own:
 *   1. the predicates (which PR states block, what an orphaned head is);
 *   2. the CLI against a stub `gh` on PATH — above all the FAIL DIRECTION: no `gh`, a failing
 *      `gh`, garbage from `gh` must each block the push (exit 2), never let it through;
 *   3. a real `git push` through lefthook in a throwaway CLONE (with `origin/HEAD`, like the real
 *      repos), for the case that decided the wiring: lefthook skips pre-push COMMANDS when the
 *      pushed tree equals the tree of `origin/HEAD`, and exits 0. The guard is a lefthook SCRIPT
 *      for that reason, and only an actual push can show that it runs and gets its stdin.
 *      (A first version of this suite built its fixture WITHOUT `origin/HEAD` — under that
 *      condition lefthook skips even pushes that change files, which made the finding look far
 *      broader than it is. The fixture below is a real `git clone`.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
/** These tests start processes (node, git, lefthook); the default 5 s is too tight under load. */
const PROCESS_TEST_TIMEOUT_MS = 30_000;
// @ts-expect-error — plain .mjs script, no type declarations
import { classifyRemote, branchUpdates, verdict, orphanHeads } from '../scripts/push-lands-guard.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts/push-lands-guard.mjs');
const HOOK = join(REPO, '.lefthook/pre-push/push-lands-guard.sh');
const LEFTHOOK = join(REPO, 'node_modules/.bin/lefthook');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);

type Verdict = { kind: 'land' } | { kind: 'merged' | 'closed'; pr: number; at: string };
const judge = (prs: unknown[]): Verdict => verdict(prs) as Verdict;

describe('classifyRemote — the EFFECTIVE push URL', () => {
  it.each([
    ['git@github.com:lynox-ai/lynox.git', 'lynox-ai/lynox'],
    ['https://github.com/lynox-ai/lynox.git', 'lynox-ai/lynox'],
    ['https://github.com/lynox-ai/lynox', 'lynox-ai/lynox'],
    ['https://x-access-token:abc@github.com/lynox-ai/lynox/', 'lynox-ai/lynox'],
    ['ssh://git@github.com/lynox-ai/lynox.git', 'lynox-ai/lynox'],
    // The forms a review measured slipping through the first, narrower parser as "not GitHub":
    ['ssh://git@ssh.github.com:443/lynox-ai/lynox.git', 'lynox-ai/lynox'],
    ['git@GitHub.com:lynox-ai/lynox.git', 'lynox-ai/lynox'],
    ['https://github.com:443/lynox-ai/lynox', 'lynox-ai/lynox'],
    ['ssh://github.com/lynox-ai/lynox', 'lynox-ai/lynox'],
    ['org-123@github.com:lynox-ai/lynox.git', 'lynox-ai/lynox'],
  ])('%s → %s', (url, repo) => {
    expect(classifyRemote(url)).toEqual({ repo });
  });

  it.each(['/tmp/remote.git', 'https://gitlab.com/a/b.git', 'git@example.com:a/b.git'])(
    'not GitHub: %s', (url) => { expect(classifyRemote(url)).toEqual({ repo: null }); });

  it.each(['git@github-work:lynox-ai/lynox.git', 'git@github.example.com:a/b.git', 'https://github.com/only-one-part'])(
    'mentions github but does not parse → unreadable, which the hook REFUSES: %s', (url) => {
      expect(classifyRemote(url)).toBe('unreadable');
    });
});

describe('branchUpdates — what a pre-push stdin announces', () => {
  it('keeps a branch RE-CREATED after auto-delete (remote sha all zeros) — the shape of the 2026-10-01 loss', () => {
    expect(branchUpdates(`refs/heads/x ${A} refs/heads/docs/y ${Z}\n`)).toEqual([
      { branch: 'docs/y', localSha: A, remoteSha: Z },
    ]);
  });

  it('drops deletions and tags', () => {
    expect(branchUpdates(`(delete) ${Z} refs/heads/gone ${A}\nrefs/tags/v1 ${A} refs/tags/v1 ${Z}\n`)).toEqual([]);
  });

  it('THROWS on a line it cannot read, instead of skipping it', () => {
    expect(() => branchUpdates('refs/heads/x not-a-sha refs/heads/x\n')).toThrow(/unreadable/);
  });
});

describe('verdict — can a push to this branch still land?', () => {
  it('an OPEN pull request wins over an older merged one (a reused branch name)', () => {
    expect(judge([{ number: 1, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' }, { number: 2, state: 'OPEN' }]))
      .toEqual({ kind: 'land' });
  });

  it('MERGED only → merged, naming the most recent merge', () => {
    expect(judge([
      { number: 1, state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' },
      { number: 7, state: 'MERGED', mergedAt: '2026-10-01T01:00:22Z' },
    ])).toEqual({ kind: 'merged', pr: 7, at: '2026-10-01T01:00:22Z' });
  });

  it('CLOSED without a merge → closed', () => {
    expect(judge([{ number: 3, state: 'CLOSED', closedAt: '2026-09-01T00:00:00Z' }]))
      .toEqual({ kind: 'closed', pr: 3, at: '2026-09-01T00:00:00Z' });
  });

  it('no pull request at all → can land (work in flight)', () => {
    expect(judge([])).toEqual({ kind: 'land' });
  });

  it('an unknown state THROWS — only the three known states have a known meaning', () => {
    expect(() => judge([{ number: 4, state: 'QUEUED' }])).toThrow(/unknown pull-request state/);
  });
});

describe('orphanHeads — the sweep predicate', () => {
  const prs = [
    { number: 10, state: 'MERGED', headRefName: 'kept', headRefOid: A },      // merged, branch not deleted
    { number: 11, state: 'MERGED', headRefName: 'late', headRefOid: A },      // merged, then pushed to
    { number: 12, state: 'MERGED', headRefName: 'reused', headRefOid: A },
    { number: 13, state: 'OPEN', headRefName: 'reused', headRefOid: B },      // reused with a new PR
    { number: 14, state: 'CLOSED', headRefName: 'dropped', headRefOid: A },   // abandoned as it was
  ];
  it('names only a head that no merged/closed PR carried and no open PR will', () => {
    const heads = [
      { name: 'main', sha: B }, { name: 'kept', sha: A }, { name: 'late', sha: B },
      { name: 'reused', sha: B }, { name: 'dropped', sha: A }, { name: 'no-pr-yet', sha: B },
    ];
    expect(orphanHeads(heads, prs)).toEqual([{ branch: 'late', sha: B, prs: [11] }]);
  });
});

// ── the CLI against a stub `gh` ─────────────────────────────────────────────────────────────

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'push-lands-')); });
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

/** A PATH whose only `gh` is a stub; `node` stays reachable via its absolute path. */
function stubPath(name: string, body: string | null): string {
  const bin = join(tmp, name);
  mkdirSync(bin, { recursive: true });
  if (body !== null) {
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
  }
  // ONLY the stub directory. `/usr/bin` carries a real `gh` on the workstation — measured: the
  // first version of the "no gh at all" case put it on PATH and its own precondition failed.
  // The stubs need nothing but `#!/bin/sh` builtins (echo, printf, case).
  return bin;
}

function hookRun(pathEnv: string, stdin: string, url = 'git@github.com:lynox-ai/lynox.git') {
  const r = spawnSync(process.execPath, [SCRIPT, 'hook', 'origin', url], {
    input: stdin, encoding: 'utf8', env: { ...process.env, PATH: pathEnv },
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const PUSH = `refs/heads/docs/y ${A} refs/heads/docs/y ${Z}\n`;

describe('hook mode — the push is blocked unless the PR state is READ and allows it', () => {
  it('MERGED → exit 1, names the PR and the way out', () => {
    const p = stubPath('merged', `echo '[{"number":1310,"state":"MERGED","mergedAt":"2026-10-01T01:00:22Z","closedAt":"2026-10-01T01:00:22Z"}]'`);
    const { code, out } = hookRun(p, PUSH);
    expect(out).toContain('#1310 was MERGED');
    expect(out).toContain('git switch -c docs/y-2');
    expect(code).toBe(1);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('CLOSED without a merge → exit 1, and the way out is to reopen', () => {
    const p = stubPath('closed', `echo '[{"number":77,"state":"CLOSED","mergedAt":null,"closedAt":"2026-09-01T00:00:00Z"}]'`);
    const { code, out } = hookRun(p, PUSH);
    expect(out).toContain('#77 was CLOSED');
    expect(out).toContain('gh pr reopen 77');
    expect(code).toBe(1);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('OPEN → exit 0', () => {
    const p = stubPath('open', `echo '[{"number":5,"state":"OPEN","mergedAt":null,"closedAt":null}]'`);
    const { code, out } = hookRun(p, PUSH);
    expect(out).toContain('can still land');
    expect(code).toBe(0);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('passes the branch NAME to gh, with an explicit --repo from the remote URL', () => {
    const log = join(tmp, 'args.log');
    const p = stubPath('args', `printf '%s\\n' "$@" > '${log}'; echo '[]'`);
    expect(hookRun(p, PUSH).code).toBe(0);
    const args = readFileSync(log, 'utf8').split('\n');
    expect(args[args.indexOf('--repo') + 1]).toBe('lynox-ai/lynox');
    expect(args[args.indexOf('--head') + 1]).toBe('docs/y');
    expect(args[args.indexOf('--state') + 1]).toBe('all');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('FAIL-CLOSED: no gh on PATH → exit 2', () => {
    const p = stubPath('none', null);
    expect(spawnSync('/bin/sh', ['-c', 'command -v gh'], { env: { PATH: p } }).status).not.toBe(0);
    const { code, out } = hookRun(p, PUSH);
    expect(out).toContain('could not check');
    expect(code).toBe(2);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('FAIL-CLOSED: gh fails (not logged in, network) → exit 2', () => {
    const p = stubPath('fails', `echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4`);
    const { code, out } = hookRun(p, PUSH);
    expect(out).toContain('gh auth login');
    expect(code).toBe(2);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('FAIL-CLOSED: gh answers something that is not a list → exit 2', () => {
    const p = stubPath('garbage', `echo '{"message":"rate limited"}'`);
    expect(hookRun(p, PUSH).code).toBe(2);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('a deletion-only push asks gh nothing (a stub that fails proves it was not called)', () => {
    const p = stubPath('never', 'exit 9');
    expect(hookRun(p, `(delete) ${Z} refs/heads/docs/y ${A}\n`).code).toBe(0);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('FAIL-CLOSED: a URL that mentions github but does not parse (ssh alias) → exit 2', () => {
    const p = stubPath('never3', 'exit 9');
    const { code, out } = hookRun(p, PUSH, 'git@github-work:lynox-ai/lynox.git');
    expect(out).toContain('looks like GitHub but does not parse');
    expect(code).toBe(2);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('empty stdin (git on an "Everything up-to-date" push) → exit 0, and still a verdict line', () => {
    const p = stubPath('never4', 'exit 9');
    const { code, out } = hookRun(p, '');
    expect(out).toContain('nothing to check');
    expect(out).toContain('push-lands-guard verdict: 0');
    expect(code).toBe(0);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('every outcome ends in its verdict line, which the shell wrapper requires', () => {
    expect(hookRun(stubPath('v-fail', 'exit 4'), PUSH).out).toContain('push-lands-guard verdict: 2');
    expect(hookRun(stubPath('v-merged', `echo '[{"number":1,"state":"MERGED","mergedAt":"x","closedAt":"x"}]'`), PUSH).out)
      .toContain('push-lands-guard verdict: 1');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('a non-GitHub remote is said out loud and passes', () => {
    const p = stubPath('never2', 'exit 9');
    const { code, out } = hookRun(p, PUSH, '/srv/git/x.git');
    expect(out).toContain('not a github.com remote');
    expect(code).toBe(0);
  }, PROCESS_TEST_TIMEOUT_MS);
});

describe('sweep mode', () => {
  const PRS = `[{"number":1310,"state":"MERGED","headRefName":"docs/y","headRefOid":"${A}"}]`;
  const stub = (refs: string) => stubPath(`sweep-${refs.length}`,
    `case "$1" in pr) echo '${PRS}';; api) printf '%s\\n' ${refs};; esac`);

  it('an orphaned head → exit 1 with the branch named', () => {
    const p = stub(`'{"name":"main","sha":"${B}"}' '{"name":"docs/y","sha":"${B}"}'`);
    const r = spawnSync(process.execPath, [SCRIPT, 'sweep', 'lynox-ai/lynox'], { encoding: 'utf8', env: { ...process.env, PATH: p } });
    expect(r.stdout).toContain('docs/y');
    expect(r.status).toBe(1);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('a branch list without main is a broken read → exit 2, not clean', () => {
    const p = stub(`'{"name":"docs/y","sha":"${A}"}'`);
    const r = spawnSync(process.execPath, [SCRIPT, 'sweep', 'lynox-ai/lynox'], { encoding: 'utf8', env: { ...process.env, PATH: p } });
    expect(`${r.stdout}${r.stderr}`).not.toContain('clean');
    expect(r.status).toBe(2);
  }, PROCESS_TEST_TIMEOUT_MS);
});

// ── the wiring: a real push through lefthook ────────────────────────────────────────────────

describe('wiring — a real push through lefthook, in a clone shaped like the real repos', () => {
  it('lefthook.yml registers it as a pre-push SCRIPT with stdin', () => {
    const doc = parse(readFileSync(join(REPO, 'lefthook.yml'), 'utf8')) as {
      'pre-push'?: { scripts?: Record<string, { runner?: string; use_stdin?: boolean }> };
    };
    expect(doc['pre-push']?.scripts?.['push-lands-guard.sh']).toEqual({ runner: 'sh', use_stdin: true });
  });

  /**
   * A seed repo carrying the REAL hook script and the REAL registration, with the node script
   * replaced by a recorder whose behaviour a `mode` file picks. Then a real `git clone` — which
   * sets `origin/HEAD`, the property the first fixture lacked — a fresh branch carrying ONLY an
   * empty commit (pushed tree == tree of origin/HEAD: the case where lefthook skips commands),
   * and a real push.
   */
  function pushThroughLefthook(mode: 'block' | 'silent0' | 'pass') {
    expect(existsSync(LEFTHOOK)).toBe(true);
    const dir = mkdtempSync(join(tmp, 'repo-'));
    const seed = join(dir, 'seed');
    const work = join(dir, 'work');
    const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
      GIT_CONFIG_GLOBAL: '/dev/null' } as NodeJS.ProcessEnv;
    const git = (cwd: string, ...a: string[]) => {
      const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', env });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
      return r;
    };
    mkdirSync(join(seed, '.lefthook/pre-push'), { recursive: true });
    mkdirSync(join(seed, 'scripts'), { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    copyFileSync(HOOK, join(seed, '.lefthook/pre-push/push-lands-guard.sh'));
    chmodSync(join(seed, '.lefthook/pre-push/push-lands-guard.sh'), 0o755);
    const real = parse(readFileSync(join(REPO, 'lefthook.yml'), 'utf8')) as { 'pre-push': { scripts: Record<string, unknown> } };
    // Only THIS guard's entry: the other scripts' wrappers are not in the seed.
    const mine = { 'push-lands-guard.sh': real['pre-push'].scripts['push-lands-guard.sh'] };
    writeFileSync(join(seed, 'lefthook.yml'), `pre-push:\n  scripts: ${JSON.stringify(mine)}\n`);
    const out = { args: join(dir, 'args'), stdin: join(dir, 'stdin') };
    writeFileSync(join(seed, 'scripts/push-lands-guard.mjs'), [
      "import { writeFileSync, readFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(out.args)}, process.argv.slice(2).join(' '));`,
      `writeFileSync(${JSON.stringify(out.stdin)}, readFileSync(0, 'utf8'));`,
      `const mode = ${JSON.stringify(mode)};`,
      "if (mode === 'block') { console.log('push-lands-guard verdict: 1'); process.exit(1); }",
      "if (mode === 'pass') { console.log('push-lands-guard verdict: 0'); process.exit(0); }",
      'process.exit(0); // silent0: exits 0 WITHOUT a verdict line',
      '',
    ].join('\n'));
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'base');
    spawnSync('git', ['clone', '-q', '--bare', seed, join(dir, 'remote.git')], { env });
    git(dir, 'clone', '-q', join(dir, 'remote.git'), work);
    expect(git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD').stdout.trim()).toBe('refs/remotes/origin/main');
    expect(spawnSync(LEFTHOOK, ['install'], { cwd: work, encoding: 'utf8', env }).status).toBe(0);
    git(work, 'switch', '-q', '-c', 'feat/claim');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'Claim track: x');
    const push = spawnSync('git', ['push', 'origin', 'feat/claim'], { cwd: work, encoding: 'utf8', env });
    const landed = spawnSync('git', ['ls-remote', join(dir, 'remote.git'), 'refs/heads/feat/claim'], { encoding: 'utf8', env }).stdout.trim() !== '';
    return { push, landed, args: readFileSync(out.args, 'utf8'), stdin: readFileSync(out.stdin, 'utf8'), remote: join(dir, 'remote.git') };
  }

  it('a fresh branch with only an empty commit reaches the guard, WITH its ref lines on stdin', () => {
    const r = pushThroughLefthook('block');
    expect(r.args).toBe(`hook origin ${r.remote}`);
    expect(r.stdin).toMatch(/^refs\/heads\/feat\/claim [0-9a-f]{40} refs\/heads\/feat\/claim 0{40}\n$/);
    expect(r.push.status).not.toBe(0);
    expect(r.landed).toBe(false);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('FAIL-CLOSED: a run that exits 0 WITHOUT its verdict line blocks the push', () => {
    const r = pushThroughLefthook('silent0');
    expect(`${r.push.stdout}${r.push.stderr}`).toContain('ended without its verdict line');
    expect(r.landed).toBe(false);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('POSITIVE CONTROL: verdict 0 lets the push through', () => {
    const r = pushThroughLefthook('pass');
    expect(r.push.status).toBe(0);
    expect(r.landed).toBe(true);
  }, PROCESS_TEST_TIMEOUT_MS);
});
