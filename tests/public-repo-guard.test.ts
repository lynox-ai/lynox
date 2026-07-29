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
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/public-repo-guard.sh', import.meta.url));

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

/** Run the guard in --staged mode inside `dir`; return the exit code. */
function runStaged(): number {
  try {
    execFileSync('bash', [SCRIPT, '--staged'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

/** Run the guard inside `dir`; return the exit code (0 = clean). */
function runGuard(): number {
  try {
    execFileSync('bash', [SCRIPT], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

function commitFile(relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  execFileSync('git', ['add', relPath], { cwd: dir });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prg-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
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
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'baseline'], { cwd: dir });

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
