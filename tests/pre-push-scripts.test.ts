/**
 * The customer-name checks run at pre-push even when the pushed tree equals the tree of
 * `origin/HEAD` — the state in which lefthook skips pre-push COMMANDS ("(skip) no matching push
 * files", exit 0; measured with lefthook 2.1.5 and 2.1.8).
 *
 * Both halves of that class look at something other than the final tree:
 *   · `check-meta` reads commit MESSAGES — a fresh branch carrying only an empty commit has a tree
 *     equal to main and a message nobody else will check (this class has no CI twin);
 *   · `check-files` walks EVERY commit in the range, so that a file added and deleted again is
 *     still found — and such a range ends on a tree equal to main.
 * So they are lefthook SCRIPTS. This drives a real push through lefthook, from a real `git clone`
 * (which sets `origin/HEAD`, the property an earlier fixture lacked and that made the skip look
 * far broader than it is), and requires each to block.
 *
 * The name is invented and assembled, never a real one; HOME is redirected so the operator's own
 * list cannot decide the result (same reason as tests/public-repo-guard.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync, chmodSync, existsSync, cpSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEFTHOOK = join(REPO, 'node_modules/.bin/lefthook');
const NAME = ['zzqx', 'fictional', 'corp'].join('-');
/** These tests start git, lefthook and bash; the default 5 s is too tight under load. */
const T = 30_000;

let tmp: string;
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'pre-push-scripts-')); });
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function setup() {
  expect(existsSync(LEFTHOOK)).toBe(true);
  const dir = mkdtempSync(join(tmp, 'case-'));
  const seed = join(dir, 'seed');
  const work = join(dir, 'work');
  const home = join(dir, 'home');
  mkdirSync(join(home, '.lynox'), { recursive: true });
  writeFileSync(join(home, '.lynox', 'private-names.re'), `${NAME}\n`);
  const env = {
    ...process.env, HOME: home, LYNOX_PRIVATE_NAMES_RE_FILE: undefined,
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  } as NodeJS.ProcessEnv;
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r;
  };
  mkdirSync(join(seed, '.lefthook/pre-push'), { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  // The REAL wrappers, the REAL guard (with its lib), and the REAL registration of these two.
  cpSync(join(REPO, 'scripts/public-repo-guard.sh'), join(seed, 'scripts/public-repo-guard.sh'));
  cpSync(join(REPO, 'scripts/lib'), join(seed, 'scripts/lib'), { recursive: true });
  const real = parse(readFileSync(join(REPO, 'lefthook.yml'), 'utf8')) as { 'pre-push': { scripts: Record<string, unknown> } };
  const mine: Record<string, unknown> = {};
  for (const name of ['public-repo-guard-meta.sh', 'public-repo-guard-files.sh']) {
    expect(real['pre-push'].scripts[name], `${name} is registered as a pre-push SCRIPT`).toBeDefined();
    mine[name] = real['pre-push'].scripts[name];
    copyFileSync(join(REPO, '.lefthook/pre-push', name), join(seed, '.lefthook/pre-push', name));
    chmodSync(join(seed, '.lefthook/pre-push', name), 0o755);
  }
  writeFileSync(join(seed, 'lefthook.yml'), `pre-push:\n  scripts: ${JSON.stringify(mine)}\n`);
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  spawnSync('git', ['clone', '-q', '--bare', seed, join(dir, 'remote.git')], { env });
  git(dir, 'clone', '-q', join(dir, 'remote.git'), work);
  expect(git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD').stdout.trim()).toBe('refs/remotes/origin/main');
  expect(spawnSync(LEFTHOOK, ['install'], { cwd: work, encoding: 'utf8', env }).status).toBe(0);
  git(work, 'switch', '-q', '-c', 'feat/x');
  const push = () => {
    const r = spawnSync('git', ['push', 'origin', 'feat/x'], { cwd: work, encoding: 'utf8', env });
    const landed = spawnSync('git', ['ls-remote', join(dir, 'remote.git'), 'refs/heads/feat/x'], { encoding: 'utf8', env }).stdout.trim() !== '';
    return { status: r.status, out: `${r.stdout}${r.stderr}`, landed };
  };
  /** The pushed tree must equal main's, or the case would not be the one lefthook skips. */
  const treeEqualsMain = () => git(work, 'rev-parse', 'HEAD^{tree}').stdout === git(work, 'rev-parse', 'origin/main^{tree}').stdout;
  return { git: (...a: string[]) => git(work, ...a), push, treeEqualsMain, work };
}

describe('the customer-name class runs on a push whose tree equals main', () => {
  it('check-meta: an empty commit whose MESSAGE carries the name is blocked', () => {
    const c = setup();
    c.git('commit', '-q', '--allow-empty', '-m', `Claim track: for ${NAME}`);
    expect(c.treeEqualsMain()).toBe(true);
    const r = c.push();
    expect(r.landed, r.out).toBe(false);
  }, T);

  it('check-files: a file that carries the name, added and deleted again, is blocked', () => {
    const c = setup();
    writeFileSync(join(c.work, 'notes.md'), `call ${NAME} back\n`);
    c.git('add', 'notes.md');
    c.git('commit', '-q', '-m', 'Add notes');
    c.git('rm', '-q', 'notes.md');
    c.git('commit', '-q', '-m', 'Remove notes');
    expect(c.treeEqualsMain()).toBe(true);
    const r = c.push();
    expect(r.landed, r.out).toBe(false);
  }, T);

  it('POSITIVE CONTROL: the same empty commit with a neutral message lands', () => {
    const c = setup();
    c.git('commit', '-q', '--allow-empty', '-m', 'Claim track: neutral');
    expect(c.treeEqualsMain()).toBe(true);
    const r = c.push();
    expect(r.landed, r.out).toBe(true);
  }, T);
});
