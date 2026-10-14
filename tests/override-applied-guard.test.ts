/**
 * `scripts/override-applied-guard.mjs` — a lockfile that records an override floor must also resolve
 * above it.
 *
 * The gap, stated once so the cases below read as the answers to it: `--frozen-lockfile` installs
 * what the lockfile says instead of re-resolving, and a plain `pnpm install` keeps an already-locked
 * version as long as the recorded `overrides:` header matches. Measured on a copy of
 * `docs/pnpm-lock.yaml` with one resolution set below its floor: the guard exits 1, both installs
 * exit 0 and keep the version, `pnpm update --depth Infinity <name>` lifts it.
 *
 * Most cases below the first two blocks exist because a specific mutant survived an earlier
 * version of this checker. The second block covers where the rules come from: the lockfile
 * header, which the declared overrides must equal. The other risk is the false positive — a checker that flags a version a scoped selector
 * legitimately explains fires on correct input, and gets deleted rather than fixed — so "does it
 * stay quiet where it must" is tested as hard as "does it fire".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
// @ts-expect-error — plain .mjs script, no type declarations
import { classifySelector, compareDeclared, evaluate, isPackageName, readRecordedOverrides, readResolved, splitNameVersion } from '../scripts/override-applied-guard.mjs';

/** These tests start node processes; the default 5 s is too tight under load. */
const PROCESS_TEST_TIMEOUT_MS = 30_000;

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(REPO, 'scripts/override-applied-guard.mjs');

type Verdict = {
  ok: boolean;
  violations: Array<{ name: string; version: string; rules: string[] }>;
  malformed: Array<{ key: string; range: string; why: string }>;
  unenforceable: Array<{ key: string; range: string }>;
  rescues: Array<{ name: string; version: string; kind: string }>;
  unmatchedNames: string[];
  checkedVersions: number;
  decidedNothing: boolean;
};

let fixture: string;
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'ovr-')); });
afterEach(() => { rmSync(fixture, { recursive: true, force: true }); });

function runGuard(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [GUARD, ...args], { cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const yamlScalar = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * A tree on disk, written by hand rather than resolved: these cases are about what the checker DOES
 * with a given tree, and generating one would make the input depend on a registry. `recorded`
 * defaults to the declared set — the coherent case.
 */
function writeTree(overrides: Record<string, unknown>, packages: string[], opts: { recorded?: Record<string, unknown>; extra?: string } = {}): string[] {
  const recorded = opts.recorded ?? overrides;
  writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'f', version: '1.0.0', pnpm: { overrides } }, null, 2));
  const header = Object.keys(recorded).length === 0
    ? ''
    : `overrides:\n${Object.entries(recorded).map(([k, v]) => `  ${JSON.stringify(k)}: ${yamlScalar(v)}\n`).join('')}\n`;
  writeFileSync(
    join(fixture, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\n\n${header}importers:\n\n  .: {}\n\npackages:\n\n${packages.map((p) => `  ${p}:\n    resolution: {integrity: sha512-x}\n`).join('\n')}\n${opts.extra ?? ''}`,
  );
  return ['--dir', fixture];
}

/** The same decision in-process: the verdict-only cases need no process of their own. */
function decide(overrides: Record<string, unknown>, packages: string[], extra = ''): Verdict {
  return evaluate({
    overrides,
    resolved: readResolved(
      `lockfileVersion: '9.0'\n\npackages:\n\n${packages.map((k) => `  ${k}:\n    resolution: {integrity: sha512-x}\n`).join('\n')}\n${extra}`,
    ),
  }) as Verdict;
}

describe('the real trees', () => {
  it('both pass, and each actually decided something — the control', () => {
    // Counted, not just exit 0: "it ran" is not "it looked at anything". And WHICH file each tree
    // read: re-pointing docs at the root lockfile would otherwise pass with two plausible lines.
    const r = runGuard([]);
    expect(r.code, r.out).toBe(0);
    const counts = [...r.out.matchAll(/\[([^\]]+?) · ([^\]]+)\]: clean ✓ \((\d+) overrides, (\d+) resolved/g)];
    expect(counts.length, 'both trees must report').toBe(2);
    for (const [, label, , overrides, checked] of counts) {
      expect(Number(overrides), `${label} must have floors to enforce`).toBeGreaterThan(0);
      expect(Number(checked), `${label} must have decided at least one version`).toBeGreaterThan(0);
    }
    expect(counts.map(([, , lock]) => lock).sort()).toEqual(['docs/pnpm-lock.yaml', 'pnpm-lock.yaml']);
  }, PROCESS_TEST_TIMEOUT_MS);

  for (const dir of ['.', 'docs']) {
    it(`a copy of ${dir === '.' ? 'the root tree' : 'docs'} with one resolution below its floor FAILS — the mutation`, () => {
      // The real files, one change: every `nanoid@3.x` resolution moved to 3.3.17, under the
      // recorded `nanoid@3: ^3.3.18`. The header stays as it is, which is exactly the state
      // `--frozen-lockfile` and a plain install both accept.
      for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) cpSync(join(REPO, dir, f), join(fixture, f));
      const lockPath = join(fixture, 'pnpm-lock.yaml');
      const lock = readFileSync(lockPath, 'utf-8');
      expect(readRecordedOverrides(lock)['nanoid@3'], 'the floor this mutation goes under').toBe('^3.3.18');
      const mutated = lock.replace(/^( {2}nanoid@)3\.\d+\.\d+(:)/gm, '$13.3.17$2');
      expect(mutated, 'the mutation must change the file').not.toBe(lock);
      writeFileSync(lockPath, mutated);
      const r = runGuard(['--dir', fixture]);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('nanoid@3.3.17 is resolved');
      expect(r.out).toContain('nanoid@3: ^3.3.18');
    }, PROCESS_TEST_TIMEOUT_MS);
  }

  it('is wired into ci.yml\'s test job, after the install it depends on, and not conditional', () => {
    // It imports semver and yaml, so it needs node_modules.
    const doc = parseYaml(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf-8')) as {
      jobs: Record<string, { if?: unknown; steps: Array<{ run?: string; if?: unknown; 'continue-on-error'?: unknown }> }>;
    };
    const steps = doc.jobs.test?.steps ?? [];
    const install = steps.findIndex((s) => s.run?.trim() === 'pnpm install --frozen-lockfile');
    const guard = steps.findIndex((s) => s.run?.trim() === 'node scripts/override-applied-guard.mjs');
    expect(install, 'the test job must still install').toBeGreaterThan(-1);
    expect(guard, 'the guard step, exactly — no flags, no `|| true`').toBeGreaterThan(install);
    expect(steps[guard]?.if, 'the guard step must not be conditional').toBeUndefined();
    expect(steps[guard]?.['continue-on-error']).toBeUndefined();
  });

  it('semver is a direct dependency, not a transitive accident', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')) as { devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.semver, 'the guard imports semver directly').toBeDefined();
    expect(pkg.devDependencies?.yaml, 'and yaml').toBeDefined();
  });
});

describe('declared against recorded — what this port adds', () => {
  it('a floor raised in package.json but not in the lockfile FAILS', () => {
    const r = runGuard(writeTree({ vite: '>=8.0.16' }, ['vite@8.2.2'], { recorded: { vite: '>=8.0.0' } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('`vite` is declared as >=8.0.16 but the lockfile records >=8.0.0');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('when the two differ, the resolution is judged against what the lockfile RECORDS', () => {
    // Declared is looser than recorded here, and 8.0.1 sits between them. Judged against the
    // declared set it would pass, and the reader would only learn "regenerate", not that the
    // installed version is below the floor pnpm itself recorded.
    const r = runGuard(writeTree({ vite: '>=8.0.0' }, ['vite@8.0.1'], { recorded: { vite: '>=8.0.16' } }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('vite@8.0.1 is resolved, but the recorded override says vite: >=8.0.16');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('names a key on either side only', () => {
    expect(compareDeclared({ a: '1', b: '2' }, { a: '1', c: '3' })).toEqual([
      { key: 'b', declared: '2', recorded: null },
      { key: 'c', declared: null, recorded: '3' },
    ]);
    expect(compareDeclared({ a: '1' }, { a: '1' })).toEqual([]);
  });

  it('a lockfile with no overrides header while package.json declares some FAILS', () => {
    // The header is where the rules come from. Without this, a missing header would mean zero
    // rules and a `clean ✓`.
    const r = runGuard(writeTree({ vite: '>=8.0.16' }, ['vite@7.0.0'], { recorded: {} }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('the lockfile records (nothing)');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('the rules are the RECORDED ones: a header floor is enforced even when package.json is coherent', () => {
    // Separating case for the source of the rules: declared == recorded here, so only the
    // resolution is wrong.
    const r = runGuard(writeTree({ vite: '>=8.0.16' }, ['vite@8.0.1']));
    expect(r.code).toBe(1);
    expect(r.out).toContain('vite@8.0.1 is resolved');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('REFUSES overrides in pnpm-workspace.yaml rather than guessing how pnpm combines them', () => {
    // Read only package.json and moving them there would be invisible; merge them and the advice
    // printed for a mismatch cannot fix it (pnpm does not combine the two that way).
    const args = writeTree({ vite: '>=8.0.16' }, ['vite@8.2.2']);
    writeFileSync(join(fixture, 'pnpm-workspace.yaml'), "packages: []\noverrides:\n  vite: '>=8.0.16'\n");
    const r = runGuard(args);
    expect(r.code).toBe(1);
    expect(r.out).toContain('pnpm-workspace.yaml declares `overrides:`');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('a pnpm-workspace.yaml WITHOUT overrides is fine — the real docs tree has one', () => {
    const args = writeTree({ vite: '>=8.0.16' }, ['vite@8.2.2']);
    writeFileSync(join(fixture, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(runGuard(args).code).toBe(0);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('REFUSES package.json `resolutions`, which pnpm also folds into overrides', () => {
    writeTree({ vite: '>=8.0.16' }, ['vite@8.2.2']);
    const pkg = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf-8')) as Record<string, unknown>;
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ ...pkg, resolutions: { vite: '8.2.2' } }));
    const r = runGuard(['--dir', fixture]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('package.json declares `resolutions`');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('a `$name` back-reference is compared by key only — pnpm writes the resolved specifier', () => {
    // Measured: `"@x/sdk": "$@x/sdk"` is recorded as the dependency's own range, e.g. `^0.98.0`.
    expect(compareDeclared({ foo: '$foo' }, { foo: '^1.2.0' })).toEqual([]);
    expect(compareDeclared({ foo: '$foo' }, {})).toEqual([{ key: 'foo', declared: '$foo', recorded: null }]);
  });

  it('a lockfile that is not YAML is an error, not a pass and not a stack trace', () => {
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'f' }));
    writeFileSync(join(fixture, 'pnpm-lock.yaml'), 'a: [unclosed\n');
    const r = runGuard(['--dir', fixture]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('could not read the tree');
  }, PROCESS_TEST_TIMEOUT_MS);
});

describe('override-applied-guard', () => {
  it('FIRES on a recorded override that was never applied', () => {
    const r = runGuard(writeTree({ vite: '7.3.5' }, ['vite@8.2.2']));
    expect(r.code, 'a recorded-but-unapplied floor must not read as clean').toBe(1);
    expect(r.out).toContain('vite@8.2.2');
    expect(r.out).toContain('vite: 7.3.5');
    // The message has to say WHY nothing else caught it, or the fix looks optional.
    expect(r.out).toContain('frozen-lockfile');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('stays quiet when the resolved version satisfies the floor', () => {
    const r = decide({ vite: '7.3.5' }, ['vite@7.3.5']);
    expect(r.ok).toBe(true);
    expect(r.checkedVersions).toBe(1);
  });

  it('does NOT fire when a scoped selector explains the version — the false-positive class', () => {
    const r = decide({ 'path-to-regexp': '^8.4.0', 'wrangler>path-to-regexp': '^6.3.0' }, ['path-to-regexp@6.3.0']);
    expect(r.ok, 'a scoped selector must not read as a violation of the bare one').toBe(true);
  });

  it('REPORTS the scoped rescue rather than passing in silence', () => {
    const r = runGuard(writeTree({ 'path-to-regexp': '^8.4.0', 'wrangler>path-to-regexp': '^6.3.0' }, ['path-to-regexp@6.3.0']));
    expect(r.out).toContain('passes only via');
    expect(r.out).toContain('wrangler>path-to-regexp');
    expect(r.out).toContain('would reject it');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('the scoped rule is what rescues it — without it the same version fires', () => {
    const r = decide({ 'path-to-regexp': '^8.4.0' }, ['path-to-regexp@6.3.0']);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatchObject({ name: 'path-to-regexp', version: '6.3.0' });
  });

  it('a version-scoped selector governs only its own major', () => {
    // `nanoid@3` is live in both trees here; nanoid 5 is outside it.
    const r = decide({ 'nanoid@3': '^3.3.18' }, ['nanoid@5.1.16', 'left-pad@1.3.0']);
    expect(r.ok, 'nanoid@3 says nothing about nanoid 5').toBe(true);
  });

  it('a version-scoped selector DOES fire inside its own major', () => {
    const r = decide({ 'nanoid@3': '^3.3.18' }, ['nanoid@3.3.17']);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatchObject({ name: 'nanoid', version: '3.3.17' });
  });

  it('reads scoped PACKAGE names, whose own @ is not the separator', () => {
    const r = decide({ '@hono/node-server': '>=1.19.15 <2' }, ["'@hono/node-server@1.19.13'"]);
    expect(r.ok, 'splitting at the first @ would lose the package entirely').toBe(false);
    expect(r.violations[0]).toMatchObject({ name: '@hono/node-server', version: '1.19.13' });
  });

  it('reads only `packages:`, never `snapshots:`', () => {
    // Real snapshot entries are a bare key on its own line with an indented block — the shape the
    // key regex matches. The unsuffixed `hono@4.0.0` would violate the floor if it were counted.
    const snapshots = [
      '', 'snapshots:', '',
      "  '@hono/node-server@1.19.17(hono@4.13.4)':", '    dependencies:', '      hono: 4.13.4', '',
      '  hono@4.0.0:', '    dependencies:', '      left-pad: 1.3.0', '',
    ].join('\n');
    const r = decide({ hono: '>=4.12.34 <5' }, ['hono@4.13.4'], snapshots);
    expect(r.ok, 'the snapshot entries must not have been counted as resolutions').toBe(true);
    expect(r.checkedVersions).toBe(1);
  });

  it('fails on a malformed override range instead of ignoring it', () => {
    const r = runGuard(writeTree({ vite: 'not-a-range' }, ['vite@7.3.5']));
    expect(r.code).toBe(1);
    expect(r.out).toContain('not a semver range');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('refuses to report clean on a tree it cannot read', () => {
    const r = runGuard(['--dir', join(fixture, 'nope')]);
    expect(r.code, 'a missing input and a clean input must not look the same').toBe(1);
    expect(r.out).toContain('does not exist');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('fails when the lockfile is missing but the package.json is not', () => {
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'f', pnpm: { overrides: { vite: '7.3.5' } } }));
    const r = runGuard(['--dir', fixture]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('does not exist');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('rejects --dir without a value, and any other argument, instead of falling back to the defaults', () => {
    for (const args of [['--dir'], ['--dir=docs'], ['--dirs', 'docs'], ['--dir', 'docs', 'extra']]) {
      const r = runGuard(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.out).toContain('usage:');
    }
  }, PROCESS_TEST_TIMEOUT_MS);

  it('resolves --dir against the working directory, not the repository', () => {
    // From `docs/`, `--dir .` means docs — not the root tree the script happens to live above.
    const out = execFileSync('node', [GUARD, '--dir', '.'], { cwd: join(REPO, 'docs'), encoding: 'utf-8' });
    expect(out).toContain(`${join(REPO, 'docs', 'pnpm-lock.yaml')}]: clean ✓`);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('runs when invoked through a symlink', () => {
    // `import.meta.url` is realpath-resolved and `process.argv[1]` is not; without the realpath
    // the CLI branch is false and the process exits 0 having checked nothing.
    const args = writeTree({ vite: '7.3.5' }, ['vite@8.2.2']);
    const link = join(fixture, 'linked-guard.mjs');
    symlinkSync(GUARD, link);
    let r: { code: number; out: string };
    try {
      r = { code: 0, out: execFileSync('node', [link, ...args], { cwd: REPO, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      r = { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
    expect(r.code, 'a symlinked invocation must still check').toBe(1);
    expect(r.out).toContain('vite@8.2.2');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('a range-valued selector key is NOT a scoped selector — the rule that vanished', () => {
    expect(classifySelector('foo@>=2 <3')).toEqual({ kind: 'versioned', name: 'foo', selectorRange: '>=2 <3' });
    const r = decide({ 'foo@>=2 <3': '>=2.5' }, ['foo@2.0.0']);
    expect(r.ok, 'the floor must still apply').toBe(false);
  });

  it('splits a scoped selector at the FIRST delimiter, as pnpm does', () => {
    expect(classifySelector('foo>bar@>=1')).toEqual({ kind: 'scoped', name: 'bar', selectorRange: '>=1' });
    expect(classifySelector('wrangler>path-to-regexp')).toEqual({ kind: 'scoped', name: 'path-to-regexp' });
    expect(classifySelector('@scope/a>@scope/b')).toEqual({ kind: 'scoped', name: '@scope/b' });
  });

  it('rejects what pnpm itself rejects, and nothing more', () => {
    expect(classifySelector('a>b>c').kind, 'pnpm raises INVALID_SELECTOR here').toBe('malformed');
    expect(classifySelector('foo>').kind).toBe('malformed');
    expect(classifySelector('@scope/pkg')).toEqual({ kind: 'bare', name: '@scope/pkg' });
    expect(classifySelector('a>b>c@1').kind).toBe('malformed');
    expect(classifySelector('.hidden@1').kind).toBe('malformed');
    // A key whose version part is not a range: `semver.satisfies` would return false for it
    // silently, a rule that can never apply.
    expect(classifySelector('foo@npm:bar').kind).toBe('malformed');
    expect(classifySelector('foo@workspace:*').kind).toBe('malformed');
  });

  it('`@>` is NOT a delimiter', () => {
    expect(classifySelector('foo@>1')).toEqual({ kind: 'versioned', name: 'foo', selectorRange: '>1' });
    expect(classifySelector('foo@^1 || >2')).toEqual({ kind: 'versioned', name: 'foo', selectorRange: '^1 || >2' });
    const r = decide({ 'foo@>1': '>=2.5' }, ['foo@2.0.0']);
    expect(r.ok, 'the floor must still apply').toBe(false);
  });

  it('drops a lockfile key whose name is not a package name, and then refuses to call it clean', () => {
    // A pnpm v6 lockfile writes `/vite@7.3.5:`.
    expect(readResolved('packages:\n\n  /vite@7.3.5:\n').size).toBe(0);
    const r = decide({ vite: '7.3.5' }, ['/vite@8.2.2']);
    expect(r.decidedNothing).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('reads a CRLF lockfile the same as LF', () => {
    const lf = "lockfileVersion: '9.0'\n\noverrides:\n  vite: 7.3.5\n\npackages:\n\n  vite@8.2.2:\n    resolution: {integrity: sha512-x}\n";
    const crlf = lf.replace(/\n/g, '\r\n');
    expect([...readResolved(lf).keys()]).toEqual(['vite']);
    expect([...readResolved(crlf).keys()], 'CRLF must read the same').toEqual(['vite']);
    expect(readRecordedOverrides(crlf)).toEqual({ vite: '7.3.5' });
  });

  it('FAILS when there are rules and the lockfile parsed to nothing', () => {
    const r = runGuard(writeTree({ vite: '7.3.5' }, []));
    expect(r.code, 'a guard that checked nothing must not report clean').toBe(1);
    expect(r.out).toContain('NOT ONE resolved version was decided');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('does not fail when there are no rules at all', () => {
    const r = decide({}, ['vite@8.2.2']);
    expect(r.ok).toBe(true);
    expect(r.decidedNothing).toBe(false);
  });

  it('does not fail when the lockfile IS readable and every rule legitimately decides nothing', () => {
    const r = decide({ 'nanoid@3': '^3.3.18' }, ['nanoid@5.1.16', 'left-pad@1.3.0']);
    expect(r.ok).toBe(true);
    expect(r.decidedNothing).toBe(false);
  });

  it('accepts pnpm override VALUES that are not version ranges, and reports them', () => {
    for (const value of ['npm:other@^2', 'workspace:*', 'link:../x', 'file:../y', 'catalog:', '$foo',
      'github:user/repo', 'user/repo', 'user/repo#semver:^2', 'git+ssh://git@github.com/u/r.git', 'ssh://git@x/y.git', 'jsr:@scope/pkg', '-']) {
      const r = decide({ bar: value }, ['bar@1.0.0']);
      expect(r.ok, `${value} is a real override value`).toBe(true);
      expect(r.unenforceable, `${value} must be reported, not silently dropped`).toHaveLength(1);
    }
  });

  it('accepts named dist-tags but still rejects a typo and an empty value', () => {
    for (const tag of ['latest', 'next', 'beta']) expect(decide({ foo: tag }, ['foo@1.0.0']).ok, tag).toBe(true);
    expect(decide({ foo: 'not-a-range' }, ['foo@1.0.0']).ok, 'a typo must still fail').toBe(false);
    // `semver.validRange('')` is `*`: an empty value would accept every version.
    const empty = decide({ vite: '' }, ['vite@8.2.2']);
    expect(empty.ok).toBe(false);
    expect(empty.malformed).toHaveLength(1);
  });

  it('treats a non-string override value as malformed', () => {
    const r = runGuard(writeTree({ vite: 7 }, ['vite@8.2.2']));
    expect(r.code).toBe(1);
    expect(r.out).toContain('not a string');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('skips a resolution that carries no comparable version, and counts it', () => {
    const r = runGuard(writeTree({ vite: '>=7.3.5' }, ['vite@link:../local-vite']));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('carry no comparable version');
  }, PROCESS_TEST_TIMEOUT_MS);

  it('matches prereleases leniently, as the header promises', () => {
    const r = decide({ vite: '>=7.3.5' }, ['vite@8.0.0-rc.1']);
    expect(r.ok).toBe(true);
    expect(r.checkedVersions, 'and it was actually decided, not skipped').toBe(1);
  });

  it('does NOT report a rescue when the bare rule also accepts the version', () => {
    const r = decide({ 'path-to-regexp': '^6.0.0', 'wrangler>path-to-regexp': '^6.3.0' }, ['path-to-regexp@6.3.0']);
    expect(r.ok).toBe(true);
    expect(r.rescues.filter((s) => s.kind === 'narrower-rule')).toHaveLength(0);
  });

  it('reports overrides that name no package in the tree', () => {
    const r = decide({ vite: '7.3.5', 'left-pad': '^1.3.0' }, ['vite@7.3.5']);
    expect(r.ok).toBe(true);
    expect(r.unmatchedNames).toEqual(['left-pad']);
  });

  it('follows npm\'s real name rule, not a near-miss of it', () => {
    expect(splitNameVersion('@scope/pkg@1.2.3')).toEqual({ name: '@scope/pkg', version: '1.2.3' });
    for (const valid of ['@scope/_x', 'foo~bar', 'foo!', "foo'bar", 'hono', '@hono/node-server', 'UPPER']) {
      expect(isPackageName(valid), valid).toBe(true);
    }
    for (const invalid of ['node_modules', 'favicon.ico', '.hidden', '_x', 'b>c', ' lead', 'trail ', '']) {
      expect(isPackageName(invalid), invalid).toBe(false);
    }
  });

  it('keeps a scoped selector\'s OWN range — a dropped narrowing widens', () => {
    expect(classifySelector('wrangler>esbuild@^0.18')).toEqual({ kind: 'scoped', name: 'esbuild', selectorRange: '^0.18' });
    expect(decide({ 'wrangler>esbuild@^0.18': '^0.18.20' }, ['esbuild@0.25.0']).ok, 'out of its reach').toBe(true);
    expect(decide({ 'wrangler>esbuild@^0.18': '^0.18.20' }, ['esbuild@0.18.5']).ok, 'inside, below the floor').toBe(false);
    // A child pref that is a tag, not a range, is dropped — kept, the rule could never apply.
    expect(classifySelector('foo>bar@latest')).toEqual({ kind: 'scoped', name: 'bar' });
    expect(decide({ 'foo>bar@latest': '^3.0.0' }, ['bar@2.9.0']).ok).toBe(false);
  });
});
