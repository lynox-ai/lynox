/**
 * The semver a canary image is named and stamped with (`.github/workflows/canary-build.yml`).
 *
 * The control plane lets an image run under a held connection only at or past a floor release,
 * and orders tags by semver. A branch or sha tag has no order and never passes a floor. A semver
 * tag does, so it has to say what the branch contains: the version comes from the published
 * releases reachable from the commit (`scripts/canary-version.sh`), never from package.json, and
 * the image reports the same value (`scripts/stamp-canary-version.mjs`, Dockerfile).
 *
 * Everything that runs is run here: the script against throwaway repositories, the stamp
 * against a throwaway package.json, and the workflow's REAL `run:` block, taken from the YAML by
 * a parser, with `gh` stubbed so this file controls which releases are published.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/canary-version.sh');
const STAMP = join(ROOT, 'scripts/stamp-canary-version.mjs');

// The control plane's two checks on a target tag, as pro declares them (packages/managed:
// lib/semver-floor.ts SEMVER_RE, services/update-manager.ts VALID_VERSION_RE). Copied, so a
// change there has to be made here too; a canary version must pass both.
const PRO_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const PRO_VALID_VERSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

let root: string;

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

let counter = 0;
function newRepo(): string {
  const dir = join(root, `repo-${counter++}`);
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'canary@example.invalid');
  git(dir, 'config', 'user.name', 'canary');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  return dir;
}

function commit(dir: string, msg: string, version = '0.0.0'): string {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version }) + '\n');
  writeFileSync(join(dir, 'log.txt'), `${msg}\n`, { flag: 'a' });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

function canaryVersion(dir: string, released: readonly string[]): { status: number | null; out: string; err: string } {
  const list = join(dir, '..', `released-${counter++}`);
  writeFileSync(list, released.map((t) => `${t}\n`).join(''));
  const r = spawnSync('bash', [SCRIPT, list], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'canary-version-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('scripts/canary-version.sh', () => {
  it('a branch that reaches the floor release gets the next patch as a canary, with its sha', () => {
    const dir = newRepo();
    commit(dir, 'release 2.17.0', '2.17.0');
    git(dir, 'tag', 'v2.17.0');
    commit(dir, 'release 2.18.0', '2.18.0');
    git(dir, 'tag', 'v2.18.0');
    const head = commit(dir, 'feature', '2.18.0');
    const r = canaryVersion(dir, ['v2.17.0', 'v2.18.0']);
    expect(r.status).toBe(0);
    expect(r.out).toBe(`2.18.1-canary.${head.slice(0, 8)}`);
    expect(r.out).toMatch(PRO_SEMVER_RE);
    expect(r.out).toMatch(PRO_VALID_VERSION_RE);
  });

  it('a branch cut before the floor release stays below it, whatever its package.json says', () => {
    const dir = newRepo();
    commit(dir, 'release 2.17.0', '2.17.0');
    git(dir, 'tag', 'v2.17.0');
    git(dir, 'checkout', '-q', '-b', 'old-branch');
    // The hand bump the version must not follow.
    const head = commit(dir, 'old work, bumped by hand', '2.99.0');
    git(dir, 'checkout', '-q', 'main');
    commit(dir, 'release 2.18.0', '2.18.0');
    git(dir, 'tag', 'v2.18.0');
    git(dir, 'checkout', '-q', 'old-branch');
    const r = canaryVersion(dir, ['v2.17.0', 'v2.18.0']);
    expect(r.out).toBe(`2.17.1-canary.${head.slice(0, 8)}`);
  });

  it('the same old branch, once it merges the floor release, reaches it', () => {
    const dir = newRepo();
    commit(dir, 'release 2.17.0', '2.17.0');
    git(dir, 'tag', 'v2.17.0');
    git(dir, 'checkout', '-q', '-b', 'old-branch');
    commit(dir, 'old work');
    git(dir, 'checkout', '-q', 'main');
    commit(dir, 'release 2.18.0', '2.18.0');
    git(dir, 'tag', 'v2.18.0');
    git(dir, 'checkout', '-q', 'old-branch');
    git(dir, 'merge', '-q', '--no-edit', '-X', 'theirs', 'main');
    const head = git(dir, 'rev-parse', 'HEAD');
    expect(canaryVersion(dir, ['v2.17.0', 'v2.18.0']).out).toBe(`2.18.1-canary.${head.slice(0, 8)}`);
  });

  it('a tag that is not a published release does not count, even when it is the highest', () => {
    const dir = newRepo();
    commit(dir, 'release 2.17.0', '2.17.0');
    git(dir, 'tag', 'v2.17.0');
    const head = commit(dir, 'pushed by hand');
    git(dir, 'tag', 'v9.0.0');
    const r = canaryVersion(dir, ['v2.17.0']);
    expect(r.out).toBe(`2.17.1-canary.${head.slice(0, 8)}`);
    // control: published, the same tag is taken
    expect(canaryVersion(dir, ['v2.17.0', 'v9.0.0']).out).toBe(`9.0.1-canary.${head.slice(0, 8)}`);
  });

  it('a release on another branch, not reachable from HEAD, does not count', () => {
    const dir = newRepo();
    commit(dir, 'release 2.17.0', '2.17.0');
    git(dir, 'tag', 'v2.17.0');
    git(dir, 'checkout', '-q', '-b', 'release/2.18.0');
    commit(dir, 'release 2.18.0', '2.18.0');
    git(dir, 'tag', 'v2.18.0');
    git(dir, 'checkout', '-q', 'main');
    const head = commit(dir, 'main moves on');
    expect(canaryVersion(dir, ['v2.17.0', 'v2.18.0']).out).toBe(`2.17.1-canary.${head.slice(0, 8)}`);
  });

  it('prerelease and malformed tags are skipped, and versions are ordered as numbers', () => {
    const dir = newRepo();
    commit(dir, 'release 2.9.0', '2.9.0');
    git(dir, 'tag', 'v2.9.0');
    commit(dir, 'release 2.10.0', '2.10.0');
    git(dir, 'tag', 'v2.10.0');
    commit(dir, 'rc');
    git(dir, 'tag', 'v2.11.0-rc.1');
    git(dir, 'tag', 'v2.12');
    const head = commit(dir, 'feature');
    const r = canaryVersion(dir, ['v2.9.0', 'v2.10.0', 'v2.11.0-rc.1', 'v2.12']);
    expect(r.out).toBe(`2.10.1-canary.${head.slice(0, 8)}`);
  });

  it('a part with a leading zero or more than six digits is not a release, so the arithmetic cannot wrap', () => {
    const dir = newRepo();
    commit(dir, 'release 1.2.999999', '1.2.999999');
    git(dir, 'tag', 'v1.2.999999');
    commit(dir, 'odd tags');
    git(dir, 'tag', 'v1.2.99999999999999999999');
    git(dir, 'tag', 'v1.09.5');
    git(dir, 'tag', 'v1.3.0000001');
    const head = commit(dir, 'feature');
    const r = canaryVersion(dir, ['v1.2.999999', 'v1.2.99999999999999999999', 'v1.09.5', 'v1.3.0000001']);
    expect(r.out).toBe(`1.2.1000000-canary.${head.slice(0, 8)}`);
    expect(r.out).toMatch(PRO_SEMVER_RE);
  });

  it('a leading zero is not a release, even where it is the only one', () => {
    // git's version sort puts `v1.09.5` below `v1.1.0`, so next to any plain release it never
    // wins. Alone, it is what the rule has to refuse.
    const dir = newRepo();
    commit(dir, 'odd tag', '1.9.5');
    git(dir, 'tag', 'v1.09.5');
    const head = commit(dir, 'feature');
    expect(canaryVersion(dir, ['v1.09.5'])).toMatchObject({ status: 0, out: '' });
    // control: without the leading zero the same commit is taken
    git(dir, 'tag', 'v1.9.5', 'HEAD~1');
    expect(canaryVersion(dir, ['v1.09.5', 'v1.9.5']).out).toBe(`1.9.6-canary.${head.slice(0, 8)}`);
  });

  it('no published release reachable: prints nothing and exits 0', () => {
    const dir = newRepo();
    commit(dir, 'first');
    git(dir, 'tag', 'v1.0.0');
    const r = canaryVersion(dir, []);
    expect(r).toMatchObject({ status: 0, out: '' });
  });

  it('refuses to run without a readable release list', () => {
    const dir = newRepo();
    commit(dir, 'first');
    const r = spawnSync('bash', [SCRIPT, join(root, 'does-not-exist')], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(spawnSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf8' }).status).toBe(2);
  });
});

describe('scripts/stamp-canary-version.mjs', () => {
  const pkgFile = (): string => {
    const f = join(root, `package-${counter++}.json`);
    writeFileSync(f, `${JSON.stringify({ name: '@lynox-ai/core', version: '2.18.0', type: 'module' }, null, 2)}\n`);
    return f;
  };
  const stamp = (file: string, version?: string) =>
    spawnSync('node', [STAMP, file, ...(version === undefined ? [] : [version])], { encoding: 'utf8' });

  it('writes a canary version and leaves every other field', () => {
    const f = pkgFile();
    expect(stamp(f, '2.18.1-canary.0123abcd').status).toBe(0);
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ name: '@lynox-ai/core', version: '2.18.1-canary.0123abcd', type: 'module' });
  });

  it('an empty or missing version changes nothing', () => {
    const f = pkgFile();
    const before = readFileSync(f, 'utf8');
    expect(stamp(f, '').status).toBe(0);
    expect(stamp(f).status).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe(before);
  });

  it('refuses a canary version without a file to write', () => {
    const r = spawnSync('node', [STAMP, '', '2.18.1-canary.0123abcd'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    // Refused by its own check, not by a crash on the missing file.
    expect(r.stderr).toMatch(/^stamp-canary-version: refusing/);
  });

  it('refuses anything but the canary shape, a release version included, and writes nothing', () => {
    for (const bad of ['2.19.0', '2.18.1-canary.0123ABCD', '2.18.1-canary.0123abc', '2.18.1-rc.1', '2.18.1-canary.0123abcd\n', '../x']) {
      const f = pkgFile();
      const before = readFileSync(f, 'utf8');
      const r = stamp(f, bad);
      expect(r.status, bad).toBe(1);
      expect(readFileSync(f, 'utf8'), bad).toBe(before);
    }
  });
});

type Step = { name?: string; id?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
const workflow = parse(readFileSync(join(ROOT, '.github/workflows/canary-build.yml'), 'utf8')) as { jobs: { build: { steps: Step[] } } };
const steps = workflow.jobs.build.steps;
const meta = steps.find((s) => s.id === 'meta');

describe('canary-build.yml', () => {
  /**
   * A `gh` that answers `gh api repos/lynox-ai/lynox/releases --paginate --jq <filter>` the way the
   * real one does: it runs the workflow's own filter with jq over a fixed API answer.
   */
  function ghReleases(releases: ReadonlyArray<{ tag_name: string; draft: boolean; prerelease: boolean }>): string {
    const fixture = join(root, `releases-${counter++}.json`);
    writeFileSync(fixture, JSON.stringify(releases));
    return [
      '[ "$1" = api ] && [ "$2" = repos/lynox-ai/lynox/releases ] || exit 9',
      'shift 2; filter=""; paginate=0',
      'while [ $# -gt 0 ]; do case "$1" in --paginate) paginate=1;; --jq) shift; filter="$1";; esac; shift; done',
      '[ "$paginate" = 1 ] && [ -n "$filter" ] || exit 9',
      `jq -r "$filter" ${JSON.stringify(fixture)}`,
    ].join('\n');
  }

  /** Runs the meta step's real `run:` block the way GitHub does, with `gh` stubbed. */
  function runMeta(dir: string, gh: string, script = SCRIPT): { status: number | null; outputs: Record<string, string>; stdout: string } {
    const bin = join(dir, '..', `bin-${counter++}`);
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\n${gh}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(script, join(dir, 'scripts/canary-version.sh'));
    const out = join(dir, '..', `out-${counter++}`);
    writeFileSync(out, '');
    const tmp = join(dir, '..', `tmp-${counter++}`);
    mkdirSync(tmp);
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', meta!.run!], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env['PATH'] ?? ''}`,
        HOME: process.env['HOME'] ?? '',
        REF_NAME: 'harden/canary-semver',
        GITHUB_SHA: git(dir, 'rev-parse', 'HEAD'),
        REPO: 'lynox-ai/lynox',
        GH_TOKEN: 'test-token',
        GITHUB_OUTPUT: out,
        RUNNER_TEMP: tmp,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    return { status: r.status, outputs, stdout: r.stdout };
  }

  function releasedRepo(): { dir: string; head: string } {
    const dir = newRepo();
    commit(dir, 'release 2.18.0', '2.18.0');
    git(dir, 'tag', 'v2.18.0');
    commit(dir, 'a prerelease');
    git(dir, 'tag', 'v2.18.5');
    commit(dir, 'a draft');
    git(dir, 'tag', 'v2.19.0');
    const head = commit(dir, 'feature');
    return { dir, head };
  }

  const API = [
    { tag_name: 'v2.19.0', draft: true, prerelease: false },
    { tag_name: 'v2.18.5', draft: false, prerelease: true },
    { tag_name: 'v2.18.0', draft: false, prerelease: false },
  ];

  it('the meta step names the canary from the published releases, drafts and prereleases left out', () => {
    const { dir, head } = releasedRepo();
    // The workflow's own `--jq` filter runs over the API answer (ghReleases).
    const r = runMeta(dir, ghReleases(API));
    expect(r.status).toBe(0);
    const v = `2.18.1-canary.${head.slice(0, 8)}`;
    expect(r.outputs['canary_version']).toBe(v);
    expect(r.outputs['canary_ref']).toBe(`ghcr.io/lynox-ai/lynox:${v}`);
    expect(r.outputs['branch_tag']).toBe('branch-harden-canary-semver');
    expect(r.outputs['sha_tag']).toBe(`sha-${head.slice(0, 7)}`);
  });

  it('when the release list cannot be read, the build gets no semver tag and still builds', () => {
    const { dir, head } = releasedRepo();
    const r = runMeta(dir, 'exit 1');
    expect(r.status).toBe(0);
    expect(r.outputs['canary_version']).toBe('');
    expect(r.outputs['canary_ref']).toBe('');
    expect(r.outputs['canary_note']).toBe('the list of published releases could not be read');
    expect(r.outputs['sha_tag']).toBe(`sha-${head.slice(0, 7)}`);
  });

  it('when the script itself fails, the build gets no semver tag and still builds', () => {
    const { dir, head } = releasedRepo();
    const failing = join(root, `failing-${counter++}.sh`);
    writeFileSync(failing, 'echo 9.9.9-canary.deadbeef; exit 3\n');
    const r = runMeta(dir, ghReleases(API), failing);
    expect(r.status).toBe(0);
    expect(r.outputs['canary_version']).toBe('');
    expect(r.outputs['canary_ref']).toBe('');
    expect(r.outputs['canary_note']).toBe('the canary version could not be computed');
    expect(r.outputs['sha_tag']).toBe(`sha-${head.slice(0, 7)}`);
  });

  it('with no published release reachable, the note says so', () => {
    const { dir } = releasedRepo();
    const r = runMeta(dir, ghReleases([]));
    expect(r.status).toBe(0);
    expect(r.outputs['canary_version']).toBe('');
    expect(r.outputs['canary_note']).toBe('no published release is reachable from this commit');
  });

  it('asks the API for published releases only, drafts and prereleases left out', () => {
    expect(meta!.run).toMatch(/select\(\.draft == false and \.prerelease == false\) \| \.tag_name/);
    expect(meta!.env?.['GH_TOKEN']).toBe('${{ github.token }}');
  });

  it('checks out the whole history, so the release tags are there', () => {
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });

  it('both builds stamp the image with the same version, and the push carries the semver tag', () => {
    const builds = steps.filter((s) => s.uses?.startsWith('docker/build-push-action@'));
    expect(builds).toHaveLength(2);
    for (const b of builds) {
      expect(String(b.with?.['build-args'])).toContain('CANARY_VERSION=${{ steps.meta.outputs.canary_version }}');
    }
    const push = builds.find((b) => b.with?.['push'] === true);
    expect(String(push?.with?.['tags'])).toContain('${{ steps.meta.outputs.canary_ref }}');
  });

  it('pushes exactly the branch, sha and semver canary tags, from one step only', () => {
    // A plain `X.Y.Z` tag here would pass every image floor on every instance.
    const pushes = steps.filter((s) => s.uses?.startsWith('docker/build-push-action@') && s.with?.['push'] === true);
    expect(pushes).toHaveLength(1);
    const tags = String(pushes[0]!.with?.['tags']).split('\n').map((t) => t.trim()).filter((t) => t !== '');
    expect(tags).toEqual([
      'ghcr.io/lynox-ai/lynox:${{ steps.meta.outputs.branch_tag }}',
      'ghcr.io/lynox-ai/lynox:${{ steps.meta.outputs.sha_tag }}',
      '${{ steps.meta.outputs.canary_ref }}',
    ]);
  });
});

describe('Dockerfile', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const production = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

  it('stamps the version in the production stage, as root, after the package.json it rewrites', () => {
    const arg = production.indexOf('\nARG CANARY_VERSION=');
    const run = production.indexOf('node /tmp/stamp-canary-version.mjs /app/package.json "$CANARY_VERSION"');
    expect(arg).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(arg);
    expect(run).toBeGreaterThan(production.indexOf('COPY --from=build-engine /app/package.json /app/package.json'));
    expect(run).toBeLessThan(production.indexOf('\nUSER lynox'));
    expect(production).toContain('--mount=type=bind,source=scripts/stamp-canary-version.mjs,target=/tmp/stamp-canary-version.mjs');
  });

  it('the build context lets the stamp script through, though scripts/ is ignored', () => {
    const lines = readFileSync(join(ROOT, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
    // The last matching rule wins in a .dockerignore.
    expect(lines.lastIndexOf('!scripts/stamp-canary-version.mjs')).toBeGreaterThan(lines.lastIndexOf('scripts/'));
  });
});
