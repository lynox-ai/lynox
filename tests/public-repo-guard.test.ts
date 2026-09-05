/**
 * Tests for scripts/public-repo-guard.sh — specifically that it FIRES.
 *
 * The CI job proves the tree is currently clean. That is a different claim from
 * "the guard still works": a typo in a pattern, a dropped `-i`, or a refactor
 * that reorders the loops all leave the tree clean and the job green, while the
 * gate quietly stops catching anything. A leak guard that cannot fail is not a
 * guard — it is a green checkmark.
 *
 * So each case plants a known-bad artifact and asserts a NON-ZERO exit, plus the
 * inverse: a benign line that must NOT trip it. The false-positive half is
 * load-bearing — folding `-i` into the main HARD pattern once made
 * `lynox[_-]managed` match every legitimate LYNOX_MANAGED_* env var (160+
 * lines across the tree), which would have painted the guard permanently red
 * and taught people to bypass it.
 *
 * Marker strings are assembled at runtime rather than written literally: a
 * literal would make THIS file a leak the guard correctly rejects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/public-repo-guard.sh', import.meta.url));
/** The repo this test file lives in — used to assert a property about the workflows. */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Assembled so this file is not itself a leak marker. */
const VENDOR = ['cli', 'proxy', 'api'].join('');
const KEY_FILE_NAME = ['local', 'eval', 'key'].join('-');
const ORG = ['router', 'for', 'me'].join('-');
const UPPER_VAR = ['CLI', 'PROXY', 'API', 'KEY'].join('_');
const INFRA_HOST = ['control', 'staging'].join('-') + '.lynox.cloud';
const PORT = 8300 + 17;

/** The doubled-bracket link delimiters, built so this file carries no literal one. */
const REF_OPEN = '['.repeat(2);
const REF_CLOSE = ']'.repeat(2);
/** A ref in the shape the private repo and the maintainer's notes use. */
const internalRef = (slug: string): string => `${REF_OPEN}${slug}${REF_CLOSE}`;
/** Must match PRAGMA in scripts/public-repo-guard.sh. */
const PRAGMA = ['public', 'repo', 'guard'].join('-') + ':allow';
/** Legal TS that wears the same brackets as a ref — the false-positive case. */
const DESTRUCTURE = `const ${REF_OPEN}first${REF_CLOSE} = rows;`;
/** A dual-use SOFT hostname, assembled like every other marker here. */
const SOFT_HOST = ['engine', 'lynox', 'cloud'].join('.');

let dir: string;

// Pin git config to /dev/null so a developer's global core.quotePath / hooksPath
// cannot make a case vacuous or run foreign hooks on the fixture commits.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

interface Run {
  code: number;
  out: string;
}

/**
 * Run the guard inside `dir` with explicit args and environment.
 *
 * HOME is redirected into the scratch directory on purpose. The guard falls back
 * to `$HOME/.lynox/private-names.re`, so leaving the real HOME in place would make
 * every result depend on whether the machine running the suite happens to have
 * that file — green on CI, different on the maintainer's laptop, for a reason no
 * failure message would mention.
 */
function run(args: string[], env: Record<string, string> = {}): Run {
  // `__PATTERN__` is not an environment variable — it writes the operator-local
  // list, which is the only source the guard has. Kept as a pseudo-env key so the
  // call sites read the same as when a variable still existed.
  const { __PATTERN__: pattern, ...realEnv } = env;
  if (pattern !== undefined) {
    mkdirSync(join(dir, '.lynox'), { recursive: true });
    writeFileSync(join(dir, '.lynox', 'private-names.re'), `${pattern}\n`);
  }
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        HOME: dir,
        // Pinned so a developer's global core.quotePath cannot make a case
        // vacuous, and so no foreign hook runs on the fixture commits. Came
        // from the tree-scan half (#1250/#1253) and applies to every mode.
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        // Redirecting HOME is not enough on its own: this one RELOCATES the file
        // and so outranks HOME entirely. Inheriting it from the developer's shell
        // would change results here, with failures that never mention why.
        LYNOX_PRIVATE_NAMES_RE_FILE: undefined,
        ...realEnv,
      } as NodeJS.ProcessEnv,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Run the guard in --staged mode inside `dir`; return the exit code. */
function runStaged(): number {
  return run(['--staged']).code;
}

/** Run the guard inside `dir`; return the exit code (0 = clean). */
function runGuard(): number {
  return run([]).code;
}

/** A name that is unmistakably invented — the list itself never enters this repo. */
const FICTIONAL_NAME = ['zzqx', 'fictional', 'corp'].join('-');
/**
 * The same name as a person would capitalise it in prose. DERIVED, not written
 * out: a literal would make this file carry the marker, which is the rule the
 * header states and which the guard promptly enforced when this was first
 * written by hand.
 */
const FICTIONAL_NAME_CAPITALISED = FICTIONAL_NAME.split('-')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join('-');

function commitFile(relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  // `--` so a path beginning with '-' (the dash-name case below) is a pathspec,
  // not a `git add` option.
  execFileSync('git', ['add', '--', relPath], { cwd: dir, env: GIT_ENV });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prg-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: GIT_ENV });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('public-repo-guard — fires on planted leaks', () => {
  it('is clean on a benign tree (baseline)', () => {
    commitFile('src/ok.ts', 'export const x = 1;\n');
    expect(runGuard()).toBe(0);
  });

  it('catches the operator-local tooling vendor name in file CONTENT', () => {
    commitFile('src/leak.ts', `// uses the local ${VENDOR} endpoint\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches separator variants the first pattern missed', () => {
    // Underscore- and space-separated spellings, plus all-caps, all slipped past
    // the first pattern (which only tolerated an optional hyphen).
    commitFile('src/leak.ts', `const ${UPPER_VAR} = '';\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches the credential file name ON ITS OWN', () => {
    // Deliberately WITHOUT the vendor string: an earlier version planted both,
    // so the case stayed green even with the key-file pattern deleted.
    commitFile('src/leak.ts', `readFileSync('/etc/secrets/.${KEY_FILE_NAME}')\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches the vendor GitHub org', () => {
    commitFile('src/leak.ts', `// see github.com/${ORG}/x\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches the loopback spelling of the default port', () => {
    commitFile('src/leak.ts', `const url = 'http://127.0.0.1:${PORT}/v1';\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches a vendored tooling directory by PATH, not just content', () => {
    // The content greps never see file names; a re-downloaded tooling dir would
    // otherwise be committable (and land in the Docker build context) unseen.
    commitFile(`${VENDOR}/readme.md`, 'nothing suspicious inside\n');
    expect(runGuard()).not.toBe(0);
  });

  it('catches the localhost spelling of the default port too', () => {
    commitFile('src/leak.ts', `const url = 'http://localhost:${PORT}/v1';\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('scans a file whose NAME contains non-ASCII bytes', () => {
    // git quotes such a path (`"Gr\303\274\303\237e.md"`), the `[ -f ]` test
    // failed on that literal, and the loop skipped the file — silently, for EVERY
    // class including the HARD ones, while the run reported a clean tree. One
    // `docs/Übersicht.md` was enough to blind a required check.
    commitFile('Grüße.md', `const h = '${INFRA_HOST}';\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('scans a non-ASCII path in --staged mode too', () => {
    // Same defect, second entry point: the staged listing quotes identically.
    commitFile('Über.md', `const h = '${INFRA_HOST}';\n`);
    expect(runStaged()).not.toBe(0);
  });

  it('scans a file whose NAME begins with a dash', () => {
    // The twin of the non-ASCII case: a repo-root path like `-x.ts` reached the
    // class greps as a leading-dash operand, which grep read as an option →
    // error → `2>/dev/null` swallowed it → the loop `continue`d, skipping a HARD
    // marker silently. The `./$f` prefix makes it an unambiguous filename. Only a
    // repo-root name is dangerous (a nested `sub/-y.ts` carries a slash).
    commitFile('-x.ts', `const h = '${INFRA_HOST}';\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('scans a SYMLINK by its target string, not the file it points at', () => {
    // git stores a symlink as a blob whose CONTENT is the target path, so the
    // path itself is committed into this public repo verbatim. The content scan
    // never saw it: `[ -f ]` follows the link, so a live link was scanned for the
    // TARGET's bytes and a dangling one was skipped outright — silently, like
    // every other blind-skip this guard has had to learn about. Measured before
    // the fix: this exact tree returned `clean ✓`, exit 0.
    const abs = join(dir, 'link.ts');
    symlinkSync(`/opt/lynox-${['man', 'aged'].join('')}/secret`, abs);
    execFileSync('git', ['add', '--', 'link.ts'], { cwd: dir, env: GIT_ENV });
    expect(runGuard()).not.toBe(0);
  });

  it('catches an internal cross-reference slug in a SYMLINK TARGET', () => {
    // The first draft asserted in a code comment that the reference and hostname
    // classes "do not apply to a path". Measured false: a link target is an
    // arbitrary committed byte string, and this rode through at exit 0 while the
    // same slug is blocked in every other file.
    const abs = join(dir, 'link.ts');
    symlinkSync(`/tmp/${internalRef('project_some_private_note')}/x`, abs);
    execFileSync('git', ['add', '--', 'link.ts'], { cwd: dir, env: GIT_ENV });
    expect(runGuard()).not.toBe(0);
  });

  it('catches a SOFT internal hostname in a SYMLINK TARGET', () => {
    const abs = join(dir, 'link.ts');
    symlinkSync(`/mnt/${SOFT_HOST}/share`, abs);
    execFileSync('git', ['add', '--', 'link.ts'], { cwd: dir, env: GIT_ENV });
    expect(runGuard()).not.toBe(0);
  });

  it('does not flag a symlink whose target is innocuous', () => {
    // The counter-direction: without it, flagging every symlink would pass the
    // case above just as happily.
    const abs = join(dir, 'link.ts');
    symlinkSync('../src/ok.ts', abs);
    execFileSync('git', ['add', '--', 'link.ts'], { cwd: dir, env: GIT_ENV });
    expect(runGuard()).toBe(0);
  });

  it('scans a dash-named path in --staged mode too', () => {
    commitFile('-y.ts', `const h = '${INFRA_HOST}';\n`);
    expect(runStaged()).not.toBe(0);
  });

  it('still scans later files when a path is literally "-" (no stdin drain)', () => {
    // The sharpest edge, and why `--` alone was not enough: a file named exactly
    // `-` is still STDIN to grep even after `--`, and inside the loop stdin is the
    // NUL file listing — grep drains it and every later file is skipped, so the
    // guard reports a clean tree. `./-` is a real path, not stdin. `zz-` sorts
    // after `-`, so the marker only surfaces if the loop survived the `-` entry.
    commitFile('-', 'nothing suspicious\n');
    commitFile('zz-leak.ts', `const h = '${INFRA_HOST}';\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('--staged scans only what is staged, not the committed tree', () => {
    // NOTE: --staged is currently unreachable from lefthook.yml, which runs the
    // guard over the whole tree. Covered anyway because the mode exists and is
    // usable by hand.
    //
    // The earlier version of this case was tautological: commitFile() only
    // stages, so `git ls-files` and `git diff --cached` were identical and the
    // test stayed green even with --staged patched into a no-op. Committing a
    // baseline first is what makes the two views differ.
    commitFile('src/leak.ts', `// uses the local ${VENDOR} endpoint\n`);
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'baseline'], { cwd: dir, env: GIT_ENV });

    // Nothing staged now: the leak is committed, so --staged must be CLEAN
    // while a full-tree run still fires. This is the assertion a no-op --staged
    // cannot satisfy.
    expect(runStaged()).toBe(0);
    expect(runGuard()).not.toBe(0);

    // Stage a fresh leak → --staged must fire.
    commitFile('src/leak2.ts', `readFileSync('/etc/secrets/.${KEY_FILE_NAME}')\n`);
    expect(runStaged()).not.toBe(0);
  });

  it('catches a pre-existing HARD infra marker', () => {
    commitFile('src/leak.ts', `const h = "${INFRA_HOST}";\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches an internal cross-reference slug in the underscore form', () => {
    commitFile('src/leak.ts', `// deferred, see ${internalRef('project_some_private_note')}\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches the hyphen+digit id form too', () => {
    // Separate case on purpose: the underscore form alone stays green if the
    // character class loses its digit or hyphen, which is how ids are written.
    commitFile('src/leak.ts', `// tracked as ${internalRef('ITEM-0042')}\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('flags a SOFT hostname with no pragma and no allow-listing', () => {
    // The inverse of the two SOFT release cases below. Without this one, deleting
    // the SOFT loop outright leaves both of them green.
    commitFile('src/soft.ts', `const h = '${SOFT_HOST}';\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches a free-text ref, not just a slug-shaped one', () => {
    // This is the exact form of one of the refs the sweep removed. The first
    // pattern allowed no spaces in the body, so this one — and only this one —
    // could have been reintroduced with the guard green. Both other positive
    // cases stayed green under that pattern, which is why this case exists.
    commitFile('src/leak.ts', `// Per ${internalRef('bug 2026-05-24 staging-walk Case 26')}.\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('catches the opening line of a ref split across lines', () => {
    // The same removed ref was ALSO wrapped across two comment lines. A
    // line-based grep can never see the whole link, so the guard matches the
    // opener instead. Asserting it here keeps that compromise honest rather
    // than silently unhandled.
    commitFile('src/leak.ts', `   * spawn fails. Per ${REF_OPEN}bug 2026-05-24\n   * staging-walk Case 26${REF_CLOSE}.\n`);
    expect(runGuard()).not.toBe(0);
  });
});

describe('public-repo-guard — does NOT fire on benign lines', () => {
  it('allows legitimate LYNOX_MANAGED_* env vars', () => {
    // The mass-false-positive case: these are a normal part of the managed wiring.
    commitFile(
      'src/env.ts',
      `const a = process.env['LYNOX_MANAGED_INSTANCE_ID'];\n` +
        `const b = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'];\n` +
        `const c = process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'];\n`,
    );
    expect(runGuard()).toBe(0);
  });

  it('allows a nested array literal, which shares the bracket pair', () => {
    // The reason the ref pattern demands a slug-ish body rather than just
    // matching the bracket pair: this line is ordinary code and exists in the
    // tree today. A shape-only pattern would paint the guard red on it.
    commitFile('src/map.ts', `const m = new Map([[key, 'a\\nb']]);\n`);
    expect(runGuard()).toBe(0);
  });

  it('lets the pragma release a legal nested destructure', () => {
    // A nested-array destructure is real TypeScript and wears the same brackets
    // as a ref; no pattern that catches free-text bodies can tell them apart.
    // There are zero such lines today, so the class starts clean — when one
    // arrives, the pragma is the way past. Without that escape the only way past
    // would be a hook bypass, which is strictly worse than the thing guarded.
    // (Assembled, like every marker here: written out, this file would be the
    // violation. Running the suite is not enough to notice — the cases execute
    // in a temp repo, so only a guard run over THIS tree catches a planted one.)
    commitFile('src/destructure.ts', `${DESTRUCTURE} // ${PRAGMA}: not a ref\n`);
    expect(runGuard()).toBe(0);
  });

  it('releases an opener line annotated AFTER the brackets', () => {
    // Passes because the trailing pragma carries a colon the body class excludes,
    // so the line stops matching before the loop ever sees it. Keep it, but do not
    // mistake it for coverage of the pragma branch — see the case below, which is
    // the one that actually exercises it.
    commitFile('src/open.ts', `const g = ${REF_OPEN}42 // ${PRAGMA}: numeric literal\n`);
    expect(runGuard()).toBe(0);
  });

  it('releases an opener line annotated BEFORE the brackets', () => {
    // The discriminating case. With the pragma first, the opener still runs to end
    // of line and still matches, so only the loop's pragma branch can release it.
    // A round of review removed that branch as "unreachable" on the strength of the
    // case above — which stayed green, because it never reached the branch at all.
    commitFile('src/open.ts', `// ${PRAGMA}: numeric literal, not a ref -- const g = ${REF_OPEN}42\n`);
    expect(runGuard()).toBe(0);
  });

  it('still fires on the same shape WITHOUT the pragma', () => {
    // The inverse of the case above. Without it, deleting the pattern entirely
    // would leave the pragma test green — the escape hatch would be proving
    // nothing about the guard it escapes.
    commitFile('src/destructure.ts', `${DESTRUCTURE}\n`);
    expect(runGuard()).not.toBe(0);
  });

  it('releases a SOFT hostname line carrying the pragma', () => {
    // The SOFT class had no coverage at all: deleting its pragma branch, or the
    // whole loop, or making is_allow_file always true, each survived every test.
    // The middle one is the same defect this suite already caught twice on the
    // reference class, so it gets asserted here rather than assumed.
    commitFile('src/soft.ts', `const h = '${SOFT_HOST}'; // ${PRAGMA}: documented on purpose\n`);
    expect(runGuard()).toBe(0);
  });

  it('allows a SOFT hostname inside an allow-listed file', () => {
    commitFile('SECURITY.md', `Reach the service at ${SOFT_HOST}.\n`);
    expect(runGuard()).toBe(0);
  });

  it('allows the configured env-var indirection that replaced the hard-coded path', () => {
    commitFile(
      'src/cfg.ts',
      `const u = process.env['LYNOX_KNOWLEDGE_PROXY_URL'];\n` +
        `const k = process.env['LYNOX_KNOWLEDGE_PROXY_KEY_FILE'];\n`,
    );
    expect(runGuard()).toBe(0);
  });
});

/**
 * The private-name class. Its pattern is supplied from outside the repo, so these
 * cases inject an obviously invented one; no real name appears here or anywhere
 * else in this repo, which is the entire point of the class.
 *
 * What makes this class different from the four above, and what therefore has to
 * be asserted rather than assumed: it must never print what it matched. On a
 * public repo the Actions log is public and the match IS the name, so a guard
 * that echoed the offending line would publish precisely what it exists to stop.
 */
/**
 * The private-name class — commit messages only.
 *
 * Not the tree and not PR text, both deliberately: see the class comment in the
 * script for what each costs and why the remaining surface is the one worth
 * covering.
 * Its pattern is supplied from outside the repo, so these cases inject an
 * obviously invented one. No real name appears here or anywhere else in this
 * repo, which is the entire point of the class.
 */
describe('public-repo-guard — private-name class', () => {
  /** Commit `subject` (optional `body`) and return the new HEAD sha. */
  function commit(subject: string, body?: string, gitConfigGlobal?: string): string {
    const args = ['commit', '-q', '--allow-empty', '-m', subject];
    if (body !== undefined) args.push('-m', body);
    execFileSync('git', args, {
      cwd: dir,
      env: {
        // GIT_ENV, not process.env: without the pins a developer's global
        // core.hooksPath runs foreign hooks on these fixture commits. Measured
        // by running this file under a hostile ambient `core.hooksPath` with
        // this one spread reverted: 13 of the cases then in the file fail. With the
        // pins: all of them pass. (The count is left out on purpose — this commit
        // appended three more cases and invalidated the denominator immediately.)
        ...GIT_ENV,
        // One case needs the fixture COMMIT written under a hostile config — the
        // lying `encoding` header is baked in at commit time, not at scan time —
        // so this single pin is overridable while the rest stay fixed.
        ...(gitConfigGlobal !== undefined ? { GIT_CONFIG_GLOBAL: gitConfigGlobal } : {}),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t.t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t.t',
      },
    });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  }

  function runMeta(base: string, head: string, env: Record<string, string> = {}): Run {
    return run(['check-meta', base, head], { __PATTERN__: FICTIONAL_NAME, ...env });
  }

  /**
   * CONFIGURED-BUT-EMPTY is its own state, and until 2026-09-04 it was not.
   *
   * The list is operator-local, so the guard cannot validate its CONTENT — but it
   * can tell "never set up" from "set up and yielding nothing", and those need
   * opposite answers. Standing down for someone who never configured the class is
   * right; standing down for a list that has been commented out, indented, or
   * emptied is the class reporting a clean scan while checking nothing.
   *
   * Not hypothetical: the real file held 34 lines of which 33 were comments, the
   * alternation came out empty, and the tick was green on every push for as long
   * as that was true. There was no visible tell either: the 23s sibling is the
   * TREE scan, a different job that runs whatever this list contains, and this
   * class armed against this class dead is hundredths apart over the same range
   * (measured 2026-09-05, three runs each: 0.029-0.033s dead, 0.049-0.061s
   * armed). Which is why nothing here asserts a duration — the number that
   * would have to separate the states does not.
   */
  describe('the pattern list is present but yields nothing', () => {
    // The comments-only form has its own case further down, which carries the
    // original empty-alternation rationale. These are the other ways a list
    // arrives dead — same verdict, different spelling.
    const EMPTY_FORMS: ReadonlyArray<readonly [string, string]> = [
      ['blank lines', '\n\n'],
      ['whitespace only', '   \n\t\n'],
      ['an indented comment', '   # indented, which the trim turns into a comment\n'],
    ];
    for (const [label, body] of EMPTY_FORMS) {
      it(`refuses with exit 2 when the file is ${label}`, () => {
        const base = commit('Add the base file');
        const head = commit(`Fix the export for ${FICTIONAL_NAME}`);
        // Written directly rather than through `__PATTERN__`, which appends a
        // newline and so cannot express "yields nothing".
        mkdirSync(join(dir, '.lynox'), { recursive: true });
        writeFileSync(join(dir, '.lynox', 'private-names.re'), body);
        const r = run(['check-meta', base, head]);

        // 2, not 1: "the gate never looked" is a different answer from "the gate
        // found something", and the exit code is the only place a caller can tell
        // them apart.
        expect(r.code).toBe(2);
        expect(r.out).toMatch(/CONFIGURED BUT UNUSABLE/);
        // It must NOT read as a hit — a reader seeing the hit message would go
        // looking for a name that is not there.
        expect(r.out).not.toMatch(/private name in the message of commit/);
      });
    }

    // The three states above are all "readable and yields nothing". These two are
    // the other half of the same class — present, NOT readable — and they are the
    // worse half: the file has real names in it. Deciding presence with `-r` put
    // them on the ABSENT path, where the class printed SKIPPED and exited 0 on a
    // commit carrying a name it was armed against. Found in review, 2026-09-05.
    it('refuses with exit 2 when an armed list cannot be READ', () => {
      const base = commit('Add the base file');
      const head = commit(`Fix the export for ${FICTIONAL_NAME}`);
      mkdirSync(join(dir, '.lynox'), { recursive: true });
      const list = join(dir, '.lynox', 'private-names.re');
      writeFileSync(list, `${FICTIONAL_NAME}\n`);
      chmodSync(list, 0o000);
      const r = run(['check-meta', base, head]);
      chmodSync(list, 0o644);

      expect(r.code).toBe(2);
      expect(r.out).toMatch(/CONFIGURED BUT UNUSABLE/);
      // The cause is named, and it is the read — not the "every line is a
      // comment" wording, which would send the operator to the wrong place.
      expect(r.out).toMatch(/cannot be READ/);
      expect(r.out).not.toMatch(/SKIPPED/);
    });

    it('refuses with exit 2 when the list is a DANGLING symlink', () => {
      // Not `-e`, so presence has to test `-L` as well: somebody who symlinked
      // the path configured the class, whatever the link now points at.
      const base = commit('Add the base file');
      const head = commit(`Fix the export for ${FICTIONAL_NAME}`);
      mkdirSync(join(dir, '.lynox'), { recursive: true });
      symlinkSync(join(dir, 'no-such-list.re'), join(dir, '.lynox', 'private-names.re'));
      const r = run(['check-meta', base, head]);

      expect(r.code).toBe(2);
      expect(r.out).toMatch(/CONFIGURED BUT UNUSABLE/);
      expect(r.out).not.toMatch(/SKIPPED/);
    });

    it('refuses with exit 2 when neither HOME nor the override resolves a path', () => {
      // The path then collapses to `/.lynox/private-names.re`, which is nobody's
      // list. Its absence says nothing about whether the class is armed, so
      // standing down is a guess — and the guess fails open.
      const base = commit('Add the base file');
      const head = commit(`Fix the export for ${FICTIONAL_NAME}`);
      const r = run(['check-meta', base, head], { HOME: '' });

      expect(r.code).toBe(2);
      expect(r.out).toMatch(/UNRESOLVABLE/);
      expect(r.out).not.toMatch(/SKIPPED/);
    });

    it('still stands down, exit 0, when the file is ABSENT', () => {
      // The other half, and the reason this is not simply "fail when unarmed":
      // blocking a push for someone who never configured the class teaches
      // --no-verify, which costs more than the class is worth. Deleting the file
      // is the documented way to stand it down deliberately.
      const base = commit('Add the base file');
      const head = commit(`Fix the export for ${FICTIONAL_NAME}`);
      const r = run(['check-meta', base, head]);

      expect(r.code).toBe(0);
      expect(r.out).toMatch(/SKIPPED/);
    });

    it('an armed list still fires — the refusal did not disarm the class', () => {
      // The positive control. Without it, a build that refused EVERY invocation
      // would pass all four cases above.
      const base = commit('Add the base file');
      const head = commit(`Fix the export for ${FICTIONAL_NAME}`);
      const r = runMeta(base, head);

      expect(r.code).toBe(1);
      expect(r.out).toMatch(/private name in the message of commit/);
    });
  });

  it('fires on a private name in a commit message, naming only the SHA', () => {
    const base = commit('Add the base file');
    const head = commit(`Fix the export for ${FICTIONAL_NAME}`);
    const r = runMeta(base, head);

    expect(r.code).toBe(1);
    // The subject line carries the name, so `%s` must not be printed the way
    // no-ai-attribution.sh prints it. A public Actions log is public.
    expect(r.out).not.toContain(FICTIONAL_NAME);
    expect(r.out).toContain(head.slice(0, 7));
  });

  it('reads the whole commit message, not just the subject', () => {
    // A name lands in a body ("as discussed with …") far more readily than in a
    // 72-character subject. Reading only `%s` passed every case that put it in
    // the subject, which was all of them.
    const base = commit('Add the base file');
    const head = commit('An ordinary subject', `Context: agreed with ${FICTIONAL_NAME} on Tuesday.`);

    expect(runMeta(base, head).code).toBe(1);
  });

  it('reads a commit message far larger than a pipe buffer', () => {
    // `git show … | grep -q` misses these. grep exits at the first match, git
    // show keeps writing, SIGPIPE follows, and `pipefail` turns the pipeline
    // into 141 — which the condition reads as NO MATCH. Measured at ~2 MB with
    // the name in line one: missed on every run, while the clean line certified
    // "1 commit(s) scanned". Small messages pass either way, which is why this
    // needs its own case.
    const base = commit('Add the base file');
    // Via stdin, not -m: two megabytes of argv exceeds the exec limit.
    execFileSync('git', ['commit', '-q', '--allow-empty', '-F', '-'], {
      cwd: dir,
      input: `Fix for ${FICTIONAL_NAME}\n\n${'x'.repeat(2_000_000)}\n`,
      env: {
        ...GIT_ENV,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t.t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t.t',
      },
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();

    expect(runMeta(base, head).code).toBe(1);
  });

  it('scans every commit in the range, not only the newest', () => {
    const base = commit('Add the base file');
    commit(`A middle commit about ${FICTIONAL_NAME}`);
    const head = commit('A clean commit on top');

    expect(runMeta(base, head).code).toBe(1);
  });

  it('scans only base..head, so an already-merged name cannot block every PR', () => {
    // Were this to walk all of history, one name merged once would turn every
    // future PR red, and the only way to ship anything would be to bypass it.
    const base = commit(`An old commit about ${FICTIONAL_NAME}`);
    const head = commit('A clean follow-up');

    expect(runMeta(base, head).code).toBe(0);
  });

  it('refuses a non-ASCII pattern under a locale that cannot fold it', () => {
    // `grep -i` folds `\u00d6` to `\u00f6` only where the charmap knows they are one
    // letter. Measured on `Fix for Z\u00d6RBLATT Industries` against the pattern
    // `Z\u00f6rblatt`: LC_ALL=en_US.UTF-8 -> exit 1 (caught); LC_ALL=C and an unset
    // locale -> exit 0 and `clean`. An unset locale is not exotic — a hook
    // launched from a GUI client or any `env -i` context has none. Refusing is
    // the only honest answer: the scan cannot match, and saying so beats saying
    // it is clean.
    const base = commit('baseline');
    const head = commit('Fix for Z\u00d6RBLATT Industries');
    const r = runMeta(base, head, { __PATTERN__: 'Z\u00f6rblatt', LC_ALL: 'C' });
    expect(r.code, 'a refusal is "never looked" (2), not "found something" (1)').toBe(2);
    expect(r.out).toMatch(/cannot fold/);
    expect(head).not.toBe(base);
  });

  it('still runs an ASCII pattern under an ASCII locale', () => {
    // The counter-direction, because a guard that refuses correct input gets
    // bypassed: an ASCII-only list folds identically everywhere, so LC_ALL=C
    // must stay a working configuration for it.
    const base = commit('baseline');
    const head = commit(`Fix for ${FICTIONAL_NAME}`);
    const r = runMeta(base, head, { LC_ALL: 'C' });
    expect(r.code, 'an ASCII pattern must still be scanned under LC_ALL=C').toBe(1);
    // The exit code alone cannot tell these apart — a refusal returns 1 as well
    // as a hit does, and a mutation that refused UNCONDITIONALLY survived an
    // earlier version of this case for exactly that reason. So assert on which
    // of the two it was.
    expect(r.out, 'this must be a HIT, not the locale refusal').toMatch(/private name in the message of commit/);
    expect(r.out).not.toMatch(/cannot fold/);
    expect(head).not.toBe(base);
  });

  it('is not fooled by a refs/replace entry standing in front of the commit', () => {
    // `git replace` swaps a sanitised twin in front of the real object for every
    // read — including `cat-file` — and it is LOCAL state that is not pushed by
    // default, so the twin stays on the machine while the real object goes to the
    // remote. It shrinks the range walk too: measured, 2 commits reported as 1,
    // with the counter that exists to make an unwalked range visible reporting
    // the smaller number without complaint. `--no-replace-objects` on both reads
    // is what this case pins.
    const base = commit('baseline');
    const head = commit(`Fix for ${FICTIONAL_NAME}`);
    const twin = commit('A perfectly ordinary change');
    execFileSync('git', ['replace', '-f', head, twin], { cwd: dir, env: GIT_ENV });
    expect(
      execFileSync('git', ['cat-file', 'commit', head], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }),
      'the fixture must actually be replaced, or this case proves nothing',
    ).toContain('A perfectly ordinary change');
    const r = runMeta(base, head);
    expect(r.code, 'a replace ref must not hide a name').toBe(1);
    expect(r.out).toMatch(/private name in the message of commit/);

    // The RANGE is the second half and needs a different shape: `rev-list` prints
    // the ORIGINAL sha even when it traverses a replacement, so replacing the tip
    // changes nothing the message read can notice. What it can change is WHICH
    // commits are listed — so put the name on a middle commit and give the tip a
    // twin whose parent is the base. The middle commit then drops out of the walk
    // entirely and is never read at all, and the counter reports the smaller
    // number without complaint.
    const b2 = commit('baseline two');
    const middle = commit(`Fix for ${FICTIONAL_NAME} again`);
    const tip = commit('tip');
    const shortTip = execFileSync('git',
      ['commit-tree', `${b2}^{tree}`, '-p', b2, '-m', 'A perfectly ordinary change'],
      {
        cwd: dir,
        // `commit-tree` writes a commit, so it needs an identity — and GIT_ENV
        // pins the global config away, which is the point. Locally the ambient
        // config filled the gap and hid this; on a CI runner with no identity at
        // all it failed with `Author identity unknown`. Pass the same identity
        // `commit()` uses.
        env: {
          ...GIT_ENV,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t.t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t.t',
        },
        encoding: 'utf8',
      }).trim();
    execFileSync('git', ['replace', '-f', tip, shortTip], { cwd: dir, env: GIT_ENV });
    expect(middle).not.toBe(tip);
    const r2 = runMeta(b2, tip);
    expect(r2.code, 'a shortened ancestry must not drop a commit out of the walk').toBe(1);
    expect(r2.out).toMatch(/private name in the message of commit/);
  });

  it('reads the raw commit object, so a lying encoding header cannot hide a name', () => {
    // `i18n.commitEncoding` writes an `encoding` header into the OBJECT while the
    // bytes stay whatever the terminal produced. Every rendering read
    // (`git show --format=%B`) then re-encodes from an encoding that was never
    // true, and the lie survives rebase, cherry-pick and clone — no hostile
    // config is needed at scan time. `git cat-file` hands back the stored bytes.
    const cfg = join(dir, 'commitenc.gitconfig');
    writeFileSync(cfg, '[i18n]\n\tcommitEncoding = ISO-8859-1\n');
    const base = commit('baseline');
    const head = commit('Fix for Z\u00f6rblatt', undefined, cfg);
    expect(
      execFileSync('git', ['cat-file', 'commit', head], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }),
      'the fixture must carry the lying header, or this case proves nothing',
    ).toMatch(/^encoding ISO-8859-1$/m);
    const r = runMeta(base, head, { __PATTERN__: 'Z\u00f6rblatt' });
    expect(r.code, 'a lying encoding header must not hide a name').toBe(1);
    // The pattern here is non-ASCII and the locale is deliberately NOT pinned, so
    // on an ASCII-locale machine the locale preflight would refuse before a single
    // commit is read — and used to satisfy this case, which asserted only the
    // exit code. Two mutants survived it that way, including a revert of the very
    // line it exists to pin. Assert WHICH outcome this was.
    expect(r.out, 'this must be a HIT, not the locale refusal').toMatch(/private name in the message of commit/);
    expect(r.out).not.toMatch(/cannot fold/);
  });

  it('is not blinded by a global i18n.logOutputEncoding', () => {
    // Found by a refuter, reproduced before fixing, and it is a PRODUCTION
    // fail-open rather than a test-only one: this class runs at pre-push with the
    // developer's real ~/.gitconfig. With `i18n.logOutputEncoding = UTF-16` set
    // there, `git show --format=%B` hands back UTF-16, grep matches nothing, and
    // the guard printed `clean ✓ (1 commit(s) scanned)` and exit 0 on a commit
    // whose subject plainly carried the name — the counter added to make an
    // unwalked range visible instead certifying a walk that could not match.
    // ISO-8859-1 does the same to an umlaut. The fix pins the encoding on the
    // `git show`, the way guard-file-list.sh already pins core.quotePath on
    // `ls-files`; this case is what keeps it pinned.
    const base = commit('baseline');
    const head = commit(`Fix for ${FICTIONAL_NAME}`);
    const hostile = join(dir, 'hostile.gitconfig');
    writeFileSync(hostile, '[i18n]\n\tlogOutputEncoding = UTF-16\n');
    const r = runMeta(base, head, { GIT_CONFIG_GLOBAL: hostile });
    expect(r.code, 'a global output encoding must not blind the scan').toBe(1);
    expect(r.out).not.toContain(FICTIONAL_NAME);
  });

  it('matches case-insensitively — prose capitalises a company name', () => {
    const base = commit('Add the base file');
    const head = commit(`Fix for ${FICTIONAL_NAME_CAPITALISED}`);

    expect(runMeta(base, head).code).toBe(1);
  });

  it('passes on clean commits', () => {
    const base = commit('Add the base file');
    const head = commit('A perfectly ordinary change');

    expect(runMeta(base, head).code).toBe(0);
  });

  it('refuses an unresolvable range instead of reading it as empty', () => {
    // A base that is not in the clone — force-push, GC, a shallow CI checkout —
    // made rev-list fail into a swallowed stderr, and the empty result read as
    // "no commit carries a name". A fail-open on the one surface that cannot be
    // edited after a merge.
    const base = commit('Add the base file');
    const head = commit(`Fix for ${FICTIONAL_NAME}`);

    const r = runMeta('0'.repeat(40), head);
    expect(r.code).toBe(1);
    expect(r.out).toContain('cannot resolve');

    const clean = runMeta(base, head, { __PATTERN__: 'nevermatchesanything' });
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('1 commit(s) scanned');
  });

  it('says so when the range held no commits at all', () => {
    // Zero is the count that means two things: an empty range and a range
    // nothing was read from. Resolvability does not separate them — base == head
    // resolves fine and walks nothing.
    const base = commit('Add the base file');
    const r = runMeta(base, base);

    expect(r.code).toBe(0);
    expect(r.out).toContain('NO commits');
  });

  it('stands down without a pattern, and refuses a half-given range', () => {
    // Absent pattern is a WARNING, not a failure: this runs at pre-push and
    // nowhere else, so refusing to run would mean refusing to push. The warning
    // is what keeps the stood-down state from being invisible.
    const base = commit('Add the base file');

    const r = run(['check-meta', base, base]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('SKIPPED');

    // A missing head is still a usage error, not an empty range read as clean.
    expect(run(['check-meta', base], { __PATTERN__: FICTIONAL_NAME }).code).toBe(2);
  });

  it('refuses a flag where a ref belongs, in either position', () => {
    const base = commit('Add the base file');

    expect(run(['check-meta', '--staged', base], { __PATTERN__: FICTIONAL_NAME }).code).toBe(2);
    expect(run(['check-meta', base, '--allow-missing-names'], { __PATTERN__: FICTIONAL_NAME }).code).toBe(2);
  });

  it('says the class is inactive rather than reporting an empty scan (pre-push path)', () => {
    // The path a push takes with no list configured. "0 commits scanned"
    // would be true but ambiguous — it is also what a real empty range prints.
    const r = run(['check-meta', 'HEAD', 'HEAD']);

    expect(r.code).toBe(0);
    expect(r.out).toContain('inactive');
    expect(r.out).not.toContain('commit(s) scanned');
  });

  it('arms itself from the pattern alone — the opt-out does not disarm it', () => {
    // The promise of the staged rollout: CI passes the opt-out today, and
    // setting the secret makes the class live with no change to script or
    // workflow. That holds only while the flag governs ABSENCE of a pattern.
    const base = commit('Add the base file');
    const head = commit(`Fix for ${FICTIONAL_NAME}`);

    expect(run(['check-meta', base, head], { __PATTERN__: FICTIONAL_NAME }).code).toBe(1);
  });
});

/** Where the pattern comes from, and what the guard refuses to run with. */
describe('public-repo-guard — private-name pattern source and preflight', () => {
  function commitNamed(): { base: string; head: string } {
    const env = {
      ...GIT_ENV,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t.t',
    };
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir, env });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', `Fix for ${FICTIONAL_NAME}`], { cwd: dir, env });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
    return { base, head };
  }

  function writeList(content: string): void {
    mkdirSync(join(dir, '.lynox'), { recursive: true });
    writeFileSync(join(dir, '.lynox', 'private-names.re'), content);
  }

  it('reads the pattern from the operator-local file, its only source', () => {
    // This is the ONLY source. The pre-push hook passes no environment, and there
    // is no CI half — if the file is not read, the class never runs at all.
    const { base, head } = commitNamed();
    writeList(`# a comment\n\n${FICTIONAL_NAME}\n`);

    const r = run(['check-meta', base, head]);
    // Asserting the HIT, not merely a non-zero exit: a stood-down class exits 0,
    // so only the anchor tells "found it" from "did not look".
    expect(r.code).toBe(1);
    expect(r.out).toContain(head.slice(0, 7));
  });

  it('joins several file lines into one alternation', () => {
    const { base, head } = commitNamed();
    writeList(`neverappears\n${FICTIONAL_NAME}\n`);

    // A `head -1` or a missing join leaves every entry but the first unenforced.
    expect(run(['check-meta', base, head]).code).toBe(1);
  });

  it('re-reads the list on every run, so an edit takes effect immediately', () => {
    const { base, head } = commitNamed();
    writeList('never-appears-anywhere\n');
    expect(run(['check-meta', base, head]).code).toBe(0);

    // Same run, list edited: no caching, no restart needed.
    writeList(`${FICTIONAL_NAME}\n`);
    expect(run(['check-meta', base, head]).code).toBe(1);
  });

  it('trims whitespace and CR from file entries, which would silently kill them', () => {
    // Untrimmed, each of these stays a valid regex that matches nothing: the
    // entry is dead, the guard says "clean", and nobody learns otherwise. A
    // leading space is what happens the first time someone indents the list.
    const { base, head } = commitNamed();

    writeList(`${FICTIONAL_NAME}\r\n`);
    expect(run(['check-meta', base, head]).code).toBe(1);

    writeList(`   ${FICTIONAL_NAME}   \n`);
    expect(run(['check-meta', base, head]).code).toBe(1);
  });

  it('trims before it filters, so an indented comment is still a comment', () => {
    // Filtering before trimming leaves "   # a comment" in the list as a literal
    // entry and "   " as an empty one, which joins into an empty alternative and
    // takes the whole guard down. Swapping the two survived every other case.
    const { base, head } = commitNamed();
    writeList(`   # an indented comment\n   \n${FICTIONAL_NAME}\n`);

    const r = run(['check-meta', base, head]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('empty line');
  });

  it('refuses a comments-only file instead of scanning with an empty pattern', () => {
    // The original hazard is unchanged and still the reason this case exists:
    // such a file collapses to an empty alternation, and an empty pattern matches
    // EVERYTHING — scanning with it would report every commit as a hit.
    //
    // What changed on 2026-09-04 is the exit, not the analysis. This used to read
    // as "absent": a warning and a stand-down, exit 0. That avoided the
    // false-positive storm and bought a worse failure — the class reporting a
    // clean scan forever while checking nothing, which is what the real list did
    // for as long as its 33 lines stayed commented out.
    //
    // "Match everything" and "silently pass" are not the only two options.
    // Refusing does neither: nothing is scanned, and the operator is told.
    const { base, head } = commitNamed();
    writeList('# nothing yet\n\n');

    const r = run(['check-meta', base, head]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('CONFIGURED BUT UNUSABLE');
    expect(r.out).not.toContain('private name in the message of commit');
  });

  it('rejects a pattern that matches an empty line', () => {
    // `(name|)` slips past a top-level check for an empty alternative, and GNU
    // grep then matches every line while BSD grep calls it invalid — a platform
    // split that reads as a mystery. A blank line pasted into the secret
    // textarea produces the same thing, and that is likelier than a typo.
    const { base, head } = commitNamed();

    // Asserted for `(name|)` only, and the alternative spelling of the assertion
    // is the honest part: GNU compiles it and the empty-line test catches it,
    // BSD refuses to compile it at all. Both end in a refusal, by different
    // routes — which also means this case cannot pin the empty-line check on
    // macOS: deleting that check leaves the local suite green, because the
    // validity check catches the same input first. Measured on GNU in a
    // container, deleting it DOES fail this case. CI runs on ubuntu, so that is
    // where this defence is actually held. A bare `()` is NOT covered — BSD neither rejects it nor reports it
    // as matching an empty line, so it would slip through locally while GNU
    // catches it in CI. Left uncovered deliberately rather than papered over:
    // nobody writes `()` as a customer name, and a test that accepted the local
    // behaviour would be asserting the bug.
    const r = run(['check-meta', base, head], { __PATTERN__: `(${FICTIONAL_NAME}|)` });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/empty line|cannot compile/);
  });

  it('rejects a PCRE group, which this grep accepts and then never matches', () => {
    // The silent direction, missed by three review rounds: every earlier check
    // asked whether the pattern matches too much. `(?i)Name` is valid ERE for
    // GNU grep and matches NOTHING — the class is dead and reports clean. BSD
    // grep matches it, so it works locally and dies in CI.
    const { base, head } = commitNamed();
    const r = run(['check-meta', base, head], { __PATTERN__: `(?i)${FICTIONAL_NAME}` });

    expect(r.code).toBe(2);
    expect(r.out).toContain('PCRE group');
    expect(r.out).not.toContain(FICTIONAL_NAME);
  });

  it('accepts the patterns an operator would realistically write', () => {
    // The preflight must not become the reason a real name cannot be expressed.
    const { base, head } = commitNamed();

    for (const good of ['Foo (AG|GmbH)', '\\bsmith\\b', '[Nn]ordberg', 'a[|]b', 'van\\s+der\\s+Meer']) {
      expect(run(['check-meta', base, head], { __PATTERN__: good }).code).toBe(0);
    }
  });
});

/**
 * check-files — the PATHS and CONTENT of the files a range introduces.
 *
 * The class used to scan commit messages "and nothing else", so a file named
 * after a customer, or carrying the name in its body, reached this PUBLIC repo
 * untouched as long as the message stayed neutral. Both halves are the same
 * class over two surfaces and share the arming, the preflight and the stand-down.
 *
 * Every case here runs BOTH directions. A widened name pattern that starts
 * firing on ordinary files is the failure that gets a guard deleted rather than
 * fixed, so the must-not-fire half is not decoration.
 *
 * The name is fictional and assembled at runtime, and the list is written into a
 * scratch HOME — the operator's real list never enters this repo, which is the
 * rule the class exists to keep.
 */
describe('public-repo-guard — private names in files (check-files)', () => {
  function commitAll(subject: string): string {
    execFileSync('git', ['commit', '-q', '-m', subject], {
      cwd: dir,
      env: {
        ...GIT_ENV,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t.t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t.t',
      },
    });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, env: GIT_ENV, encoding: 'utf8' }).trim();
  }

  /** A baseline commit, so every case has a range that is not rooted at nothing. */
  function baseline(): string {
    commitFile('README.md', 'baseline\n');
    return commitAll('baseline');
  }

  function runFiles(base: string, head: string, env: Record<string, string> = {}): Run {
    return run(['check-files', base, head], { __PATTERN__: FICTIONAL_NAME, ...env });
  }

  describe('fires', () => {
    it('on a name in the CONTENT of an added file', () => {
      const base = baseline();
      commitFile('docs/note.md', `A note about ${FICTIONAL_NAME_CAPITALISED} and its plan.\n`);
      const head = commitAll('add a note');

      const r = runFiles(base, head);
      expect(r.code).toBe(1);
      expect(r.out).toContain('docs/note.md');
    });

    it('on a name in the PATH, with content that says nothing', () => {
      // The shape the class was missing: no content grep ever sees a file NAME,
      // so a neutral document under a named path was invisible.
      const base = baseline();
      commitFile(`docs/${FICTIONAL_NAME}-businessplan.html`, '<p>nothing sensitive at all</p>\n');
      const head = commitAll('add a document');

      const r = runFiles(base, head);
      expect(r.code).toBe(1);
      expect(r.out).toContain('PATH');
    });

    it('on a file that carries the name in both path and content', () => {
      const base = baseline();
      commitFile(`${FICTIONAL_NAME}-notes.txt`, `${FICTIONAL_NAME_CAPITALISED} said yes.\n`);
      const head = commitAll('notes');

      expect(runFiles(base, head).code).toBe(1);
    });

    it('on a file ADDED and then DELETED inside the range — the blob still ships', () => {
      // A tree diff (base against head) cannot see this: the file is absent from
      // both ends. Its blob is still pushed, so a later `git rm` does not fix it
      // and the message says so. This is why the scan walks commits, not trees.
      const base = baseline();
      commitFile('gone.md', `${FICTIONAL_NAME_CAPITALISED}\n`);
      commitAll('add it');
      execFileSync('git', ['rm', '-q', 'gone.md'], { cwd: dir, env: GIT_ENV });
      const head = commitAll('remove it again');

      const r = runFiles(base, head);
      expect(r.code).toBe(1);
      expect(r.out).toContain('gone.md');
      expect(r.out).toContain('does not fix this');
    });

    it('on a name at the start of a LARGE file, where a pipe would lose it', () => {
      // Not a size test — a pipeline-shape test. `git cat-file blob … | grep -q`
      // exits at the first match, git keeps writing, and past the pipe buffer it
      // dies of SIGPIPE; with `pipefail` the pipeline reports 141 and the caller
      // reads it as NO MATCH. Small inputs are unaffected, which is what makes
      // the bug ship. The same shape was measured on the commit-message half.
      // 2 MB with the name in the first line, so a piped implementation fails
      // here and the temp-file one does not.
      const base = baseline();
      commitFile('big.md', `${FICTIONAL_NAME_CAPITALISED}\n${'filler filler filler\n'.repeat(100_000)}`);
      const head = commitAll('a large file');

      expect(runFiles(base, head).code).toBe(1);
    });

    it('on a ROOT commit inside the range, which diff-tree otherwise prints nothing for', () => {
      // A range can contain a commit with no parent — an orphan branch pushed
      // against main is the ordinary way to get one. `git diff-tree <root>` emits
      // NOTHING without `--root`, so the whole commit is skipped and the scan
      // reports clean. The flag was a survivor until this case existed: no other
      // range here reaches a parentless commit.
      const base = baseline();
      execFileSync('git', ['checkout', '-q', '--orphan', 'orphan'], { cwd: dir, env: GIT_ENV });
      execFileSync('git', ['rm', '-rq', '--cached', '.'], { cwd: dir, env: GIT_ENV });
      commitFile('orphan-doc.md', `${FICTIONAL_NAME_CAPITALISED} is in here.\n`);
      const head = commitAll('orphan root commit');

      const r = runFiles(base, head);
      expect(r.code).toBe(1);
      expect(r.out).toContain('orphan-doc.md');
    });

    it('on a name typed into a MERGE commit while resolving a conflict', () => {
      // diff-tree against a merge prints NOTHING without --cc, so the merge
      // contributed zero files and the scan reported "clean ✓ (N file(s))" with
      // N supplied by the sibling commits — no starvation warning either.
      // Resolving a conflict by hand is the most ordinary way a real name gets
      // typed into a repo, which is what makes this the worst of the holes an
      // adversarial pass found.
      const base = baseline();
      execFileSync('git', ['checkout', '-qb', 'side'], { cwd: dir, env: GIT_ENV });
      commitFile('c.txt', 'CLIENT: side\n');
      commitAll('side');
      execFileSync('git', ['checkout', '-q', '-'], { cwd: dir, env: GIT_ENV });
      commitFile('c.txt', 'CLIENT: main\n');
      commitAll('mainline');
      try {
        execFileSync('git', ['merge', '-q', 'side'], { cwd: dir, env: GIT_ENV });
      } catch {
        // The conflict is the point of the fixture.
      }
      commitFile('c.txt', `CLIENT: ${FICTIONAL_NAME_CAPITALISED}\n`);
      const head = commitAll('resolve the conflict');

      const r = runFiles(base, head);
      expect(r.code).toBe(1);
      expect(r.out).toContain('c.txt');
    });

    it('on a TYPE CHANGE — a file that becomes a symlink naming the customer', () => {
      // Status `T` is neither A nor M, so `--diff-filter=ACMR` listed it nowhere
      // and both directions shipped clean: a regular file replaced by a symlink
      // whose TARGET carries the name, and a symlink replaced by a regular file
      // full of prose.
      const base = baseline();
      commitFile('ref.txt', 'plain file\n');
      commitAll('a plain file');
      rmSync(join(dir, 'ref.txt'));
      symlinkSync(`../${FICTIONAL_NAME}-prod-notes/secret.md`, join(dir, 'ref.txt'));
      execFileSync('git', ['add', '--', 'ref.txt'], { cwd: dir, env: GIT_ENV });
      const head = commitAll('turn it into a symlink');

      const r = runFiles(base, head);
      expect(r.code).toBe(1);
      expect(r.out).toContain('ref.txt');
    });

    it('on a path whose bytes are non-ASCII, which git would otherwise quote away', () => {
      // Without `-z` git renders such a path as an escaped, quoted string; the
      // loop then reads a literal that matches no file and the scan skips it
      // while reporting clean. Same measurement as the tree scan's own note.
      const base = baseline();
      commitFile(`docs/Übersicht-${FICTIONAL_NAME}.md`, 'neutral\n');
      const head = commitAll('umlaut path');

      expect(runFiles(base, head).code).toBe(1);
    });
  });

  describe('does not fire', () => {
    it('on a file that existed at the base and is only DELETED by the range', () => {
      // Its content is leaving the repo. Firing here would block the very commit
      // that removes a name, which is the opposite of what the class wants.
      commitFile('README.md', 'baseline\n');
      commitFile('pre.md', `${FICTIONAL_NAME_CAPITALISED}\n`);
      const base = commitAll('seed with the file already present');
      execFileSync('git', ['rm', '-q', 'pre.md'], { cwd: dir, env: GIT_ENV });
      const head = commitAll('remove it');

      expect(runFiles(base, head).code).toBe(0);
    });

    it('on a file whose PATH carries the name and which the range DELETES', () => {
      // This is the case that makes `--diff-filter=ACMR` load-bearing, and it was
      // missing: with the filter widened to include D, the earlier delete case
      // still passed, because the file no longer exists at that commit and the
      // content read simply finds nothing. The PATH check has no such guard — it
      // reads the listing directly — so a deletion would fire on the very commit
      // that removes the name, and the only way out would be to bypass the hook.
      commitFile('README.md', 'baseline\n');
      commitFile(`${FICTIONAL_NAME}-plan.md`, 'neutral prose\n');
      const base = commitAll('seed with a named path already present');
      execFileSync('git', ['rm', '-q', `${FICTIONAL_NAME}-plan.md`], { cwd: dir, env: GIT_ENV });
      const head = commitAll('remove the named file');

      expect(runFiles(base, head).code).toBe(0);
    });

    it('on substrings that merely contain the name', () => {
      // The word boundary lives in the operator's pattern, not here — this case
      // exists so a pattern change that drops it is visible. A near-miss has
      // already happened once in this class, on a brand written with spaces.
      //
      // Both continuations are WORD characters, and that is the whole fixture.
      // The first draft used `<name>-adjacent`, which is not a near miss at all:
      // a hyphen IS a word boundary, so `\bname\b` matches it and the case
      // failed. The fixture was wrong in the direction that invites loosening
      // the guard to make a test pass.
      const base = baseline();
      commitFile('near.md', `The ${FICTIONAL_NAME}ish hypothesis and ${FICTIONAL_NAME}oration.\n`);
      const head = commitAll('near miss');

      expect(runFiles(base, head, { __PATTERN__: `\\b${FICTIONAL_NAME}\\b` }).code).toBe(0);
    });

    it('on an ordinary file with no name anywhere', () => {
      const base = baseline();
      commitFile('ordinary.md', 'ordinary text about ordinary things\n');
      const head = commitAll('ordinary');

      expect(runFiles(base, head).code).toBe(0);
    });
  });

  describe('says what it did rather than implying it', () => {
    it('names an empty range instead of reporting a clean scan of nothing', () => {
      const base = baseline();

      const r = runFiles(base, base);
      expect(r.code).toBe(0);
      expect(r.out).toContain('NO files');
    });

    it('stands down visibly when no list is configured', () => {
      const base = baseline();
      commitFile('x.md', `${FICTIONAL_NAME_CAPITALISED}\n`);
      const head = commitAll('x');

      // No `__PATTERN__`: nothing is written into the scratch HOME.
      const r = run(['check-files', base, head]);
      expect(r.code).toBe(0);
      expect(r.out).toContain('SKIPPED');
    });

    it('refuses when the list is configured but yields nothing', () => {
      // exit 2 = "the gate never looked", which must stay distinct from 1 = "the
      // gate found something". Same arming block as check-meta, so this asserts
      // the sharing rather than a second implementation.
      const base = baseline();
      commitFile('x.md', `${FICTIONAL_NAME_CAPITALISED}\n`);
      const head = commitAll('x');

      const r = run(['check-files', base, head], { __PATTERN__: '# only a comment' });
      expect(r.code).toBe(2);
      expect(r.out).toContain('CONFIGURED BUT UNUSABLE');
    });

    it('refuses a range it cannot resolve rather than calling it clean', () => {
      const base = baseline();

      const r = runFiles('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', base);
      expect(r.code).toBe(1);
      expect(r.out).toContain('cannot resolve');
    });

    it('refuses both subcommands at once — they share one pair of refs', () => {
      const base = baseline();

      const r = run(['check-meta', base, base, 'check-files', base, base]);
      expect(r.code).toBe(2);
    });
  });

  /**
   * ⛔ THE STRUCTURAL SAFETY PROPERTY, and it is the reason this half can print
   * paths at all.
   *
   * An earlier tree-scanning version of this class ran in CI, where a public
   * Actions log must not print a name. It therefore withheld the matching line,
   * then had to withhold the path too, and the withholding used the same grep as
   * the detection — so it was blind exactly where the detection was blind. It was
   * removed for that.
   *
   * This half reports plainly because it runs at PRE-PUSH on the operator's own
   * machine, where the list is already theirs. That is only true while no
   * workflow invokes it. This asserts it, so wiring it into CI fails here instead
   * of quietly printing a customer name into a public log.
   */
  /**
   * The whole of `.github`, recursively — not just the workflow YAML files. A
   * composite action lives at `.github/actions/<name>/action.yml`, and a workflow
   * can call a script that calls this; the narrow first version saw neither.
   *
   * (Written without a glob on purpose: a `<star><slash>` inside a block comment
   * closes it, which is exactly how the first draft of this comment turned the
   * rest of the file into code.)
   *
   * It still cannot see an arbitrary indirection, said here rather than left to
   * be found: it catches the ways this would plausibly be wired, not every way it
   * could be.
   */
  function invokersUnder(root: string): string[] {
    const found: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ya?ml|sh|mjs|js)$/u.test(e.name) && /check-['"]?files/u.test(readFileSync(p, 'utf8'))) {
          found.push(p.slice(root.length));
        }
      }
    };
    walk(root);
    return found;
  }

  it('finds an invoker wherever it is wired — positive control on the walk', () => {
    // Without this the recursion and the quote-tolerant match are unfalsifiable:
    // the real `.github` has no offender, so narrowing the walk back to
    // the workflow directory alone passed unchanged. A planted composite action
    // and a called script are what make the widening a tested decision.
    const root = mkdtempSync(join(tmpdir(), 'prg-wf-'));
    mkdirSync(join(root, 'actions', 'probe'), { recursive: true });
    writeFileSync(
      join(root, 'actions', 'probe', 'action.yml'),
      "runs:\n  steps:\n    - run: bash scripts/public-repo-guard.sh check-files A B\n",
    );
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'ci.sh'), "public-repo-guard.sh check-'files' \"$A\" \"$B\"\n");

    expect(invokersUnder(root).sort()).toHaveLength(2);
    rmSync(root, { recursive: true, force: true });
  });

  it('is invoked by nothing under .github — printing paths is safe only locally', () => {
    expect(invokersUnder(join(REPO_ROOT, '.github'))).toEqual([]);
  });
});
