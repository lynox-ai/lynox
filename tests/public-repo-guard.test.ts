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
  try {
    const out = execFileSync('bash', [SCRIPT, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe',
      env: {
        ...process.env,
        HOME: dir,
        // Redirecting HOME is not enough on its own: both of these OUTRANK it —
        // the first replaces the file, the second relocates it — so inheriting
        // them from the developer's shell would change results here. And the
        // operator is told by CLAUDE.md to export exactly the first one, which
        // would have broken `pnpm test` for the person following the docs, with
        // failures that never mention why.
        LYNOX_PRIVATE_NAMES_RE: undefined,
        LYNOX_PRIVATE_NAMES_RE_FILE: undefined,
        ...env,
      } as NodeJS.ProcessEnv,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * The private-name class fails closed when its pattern is absent, so every case
 * that is about one of the OTHER four classes opts out of it — exactly as the
 * pre-push hook does. Without this the whole suite would exit 1 for a reason
 * that has nothing to do with what it is asserting.
 */
const OPT_OUT = '--allow-missing-names';

/** Run the guard in --staged mode inside `dir`; return the exit code. */
function runStaged(): number {
  return run(['--staged', OPT_OUT]).code;
}

/** Run the guard inside `dir`; return the exit code (0 = clean). */
function runGuard(): number {
  return run([OPT_OUT]).code;
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

/** Run the guard WITH a private-name pattern, i.e. the way CI runs it. */
function runWithNames(pattern: string = FICTIONAL_NAME): Run {
  return run([], { LYNOX_PRIVATE_NAMES_RE: pattern });
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
describe('public-repo-guard — private-name class', () => {
  it('fires on a private name in file content', () => {
    commitFile('src/leak.ts', `const owner = '${FICTIONAL_NAME}';\n`);
    expect(runWithNames().code).toBe(1);
  });

  it('reports file and line number but NEVER the matching line', () => {
    commitFile('src/leak.ts', `const a = 1;\nconst owner = '${FICTIONAL_NAME}';\n`);
    const r = runWithNames();

    expect(r.code).not.toBe(0);
    // The anchor a reader needs to find it...
    expect(r.out).toContain('src/leak.ts:2');
    // ...without the payload. Dropping `cut -d: -f1` from the loop, or reusing the
    // `echo "     ${line}"` shape the other classes use, fails exactly here.
    expect(r.out).not.toContain(FICTIONAL_NAME);
  });

  it('withholds the PATH itself when the name is in the path', () => {
    commitFile(`vendor/${FICTIONAL_NAME}-notes.md`, 'nothing sensitive inside\n');
    const r = runWithNames();

    expect(r.code).not.toBe(0);
    expect(r.out).toContain('tracked PATH');
    expect(r.out).not.toContain(FICTIONAL_NAME);
  });

  it('is HARD: the inline pragma does not release it', () => {
    // The pragma rescues the SOFT and reference classes. A customer name is never
    // public-safe, so it must not have that escape — if the new loop is ever moved
    // below the pragma-honouring ones, this is the case that notices.
    commitFile('src/leak.ts', `const o = '${FICTIONAL_NAME}'; // ${PRAGMA}: looks fine\n`);
    expect(runWithNames().code).toBe(1);
  });

  it('is HARD: an allow-listed file does not release it either', () => {
    // CHANGELOG.md may carry the dual-use hostnames wholesale. It may not carry a
    // customer name — which holds only while this loop stays ABOVE the
    // `is_allow_file … continue` line.
    commitFile('CHANGELOG.md', `Fixed an issue reported by ${FICTIONAL_NAME}.\n`);
    expect(runWithNames().code).toBe(1);
  });

  it('does not fire on an unrelated tree', () => {
    commitFile('src/ok.ts', 'export const x = 1;\n');
    expect(runWithNames().code).toBe(0);
  });

  it('matches regardless of case — a name in prose is capitalised', () => {
    // The list is written lowercase; a human writing about a company writes
    // its capitalised form. Every -i in the class was removable without a single
    // test noticing, because every case here planted the lowercase form.
    commitFile('src/leak.ts', `// discussed with ${FICTIONAL_NAME_CAPITALISED} last week\n`);
    expect(runWithNames().code).toBe(1);
  });

  it('matches case-insensitively in a PATH too', () => {
    commitFile(`vendor/${FICTIONAL_NAME_CAPITALISED}-notes.md`, 'nothing\n');
    expect(runWithNames().code).toBe(1);
  });

  it('withholds the line even when another class matches it as well', () => {
    // The class's own restraint was worth nothing while its four neighbours
    // echoed their matching line verbatim: one line can trip two classes, and
    // "customer X runs on <service host>" is precisely what the SOFT class is
    // for. The name went straight into a public Actions log.
    commitFile('src/doc.ts', `// ${FICTIONAL_NAME} runs on ${SOFT_HOST}\n`);
    const r = runWithNames();

    expect(r.code).not.toBe(0);
    expect(r.out).toContain('internal hostname'); // the neighbour did fire…
    expect(r.out).toContain('withheld'); // …and said so without the payload
    expect(r.out).not.toContain(FICTIONAL_NAME);
  });

  it('rejects a malformed pattern instead of scanning with it', () => {
    // A company name with a parenthesis is the most ordinary edit this list will
    // ever get. Untreated, grep exits 2 into a swallowed stderr, the loop never
    // runs, and the guard prints "clean" — the exact failure direction the class
    // comment claims to have designed away.
    commitFile('src/leak.ts', `const o = '${FICTIONAL_NAME}';\n`);
    const r = run([], { LYNOX_PRIVATE_NAMES_RE: `${FICTIONAL_NAME}|Some Corp (CH` });

    expect(r.code).toBe(1);
    expect(r.out).toContain('not a valid extended regex');
    // The diagnostic must not quote the pattern — it is the list of names.
    expect(r.out).not.toContain(FICTIONAL_NAME);
  });

  it('rejects an empty alternative, which would match every line', () => {
    // One trailing `|` in the list. GNU grep accepts it and matches everything
    // (CI goes red on the whole tree); BSD grep calls it an error (locally green).
    // Both roads end at "just disable the class", so neither is allowed.
    commitFile('src/ok.ts', 'export const x = 1;\n');

    expect(run([], { LYNOX_PRIVATE_NAMES_RE: `${FICTIONAL_NAME}|` }).code).toBe(1);
    expect(run([], { LYNOX_PRIVATE_NAMES_RE: `|${FICTIONAL_NAME}` }).code).toBe(1);
    expect(run([], { LYNOX_PRIVATE_NAMES_RE: `a||b` }).code).toBe(1);
    expect(run([], { LYNOX_PRIVATE_NAMES_RE: `a||b` }).out).toContain('empty alternative');
  });

  it('trims whitespace and CR from file entries, which would silently kill them', () => {
    // Untrimmed, each of these stays a valid regex that matches nothing: the
    // entry is dead, the guard says "clean", and nobody learns otherwise. A
    // leading space is what happens the first time someone indents the list.
    commitFile('src/leak.ts', `const o = '${FICTIONAL_NAME}';\n`);
    mkdirSync(join(dir, '.lynox'), { recursive: true });
    const file = join(dir, '.lynox', 'private-names.re');

    writeFileSync(file, `${FICTIONAL_NAME}\r\n`); // CRLF file
    expect(run([]).code).toBe(1);

    writeFileSync(file, `   ${FICTIONAL_NAME}   \n`); // indented entry
    expect(run([]).code).toBe(1);
  });

  it('fails closed when the pattern is absent and nothing opted out', () => {
    // The direction that matters: an unset pattern must not read as "clean". If
    // the default were the other way round, dropping the env from the CI job would
    // silently turn the class off and the job would still go green.
    commitFile('src/ok.ts', 'export const x = 1;\n');
    const r = run([]);

    expect(r.code).not.toBe(0);
    expect(r.out).toContain('LYNOX_PRIVATE_NAMES_RE');
  });

  it('arms itself from the pattern alone — the opt-out does not disarm it', () => {
    // This is the whole promise of the staged rollout: CI passes the opt-out
    // today, and setting the secret is supposed to make the class live with no
    // change to the script or the workflow. That only holds while the flag
    // governs ABSENCE of a pattern and nothing else — if it ever became a plain
    // "skip this class", CI would go quiet and look exactly the same.
    commitFile('src/leak.ts', `const o = '${FICTIONAL_NAME}';\n`);
    expect(run([OPT_OUT], { LYNOX_PRIVATE_NAMES_RE: FICTIONAL_NAME }).code).toBe(1);
  });

  it('says the class is inactive rather than reporting an empty scan (check-meta)', () => {
    // The current CI path. "0 commits scanned" would be true but ambiguous: it
    // is also what a real but empty range prints, and those two must not look
    // alike on the surface that cannot be edited after a merge.
    const r = run([OPT_OUT, 'check-meta', 'HEAD', 'HEAD']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('inactive');
    expect(r.out).not.toContain('commit(s) scanned');
  });

  it('skips only this class under --allow-missing-names, and still runs the others', () => {
    commitFile('src/infra.ts', `const h = '${INFRA_HOST}';\n`);
    const r = run([OPT_OUT]);

    // The HARD infra class still fired...
    expect(r.code).not.toBe(0);
    // ...and the skip was stated out loud rather than passing silently.
    expect(r.out).toContain('SKIPPED');
  });

  it('reads the pattern from the operator-local file when no variable is set', () => {
    // Without this path the class would be dead locally: the pre-push hook passes
    // no environment, so the variable would never be set and the guard would skip
    // itself on every push while still printing "clean".
    mkdirSync(join(dir, '.lynox'), { recursive: true });
    writeFileSync(join(dir, '.lynox', 'private-names.re'), `# a comment\n\n${FICTIONAL_NAME}\n`);
    commitFile('src/leak.ts', `const o = '${FICTIONAL_NAME}';\n`);

    // HOME points at `dir`, so this is the file the guard finds. No opt-out, no
    // variable — the file alone has to arm the class.
    const r = run([]);
    expect(r.code).not.toBe(0);
    // Asserting the HIT, not merely a non-zero exit: with the file path removed
    // the guard also exits non-zero, by failing closed. Only the anchor tells the
    // two apart, so without this line the case would pass either way.
    expect(r.out).toContain('src/leak.ts:1');
  });

  it('joins several file lines into one alternation', () => {
    const other = ['qqzx', 'invented', 'gmbh'].join('-');
    mkdirSync(join(dir, '.lynox'), { recursive: true });
    writeFileSync(join(dir, '.lynox', 'private-names.re'), `${FICTIONAL_NAME}\n${other}\n`);
    commitFile('src/leak.ts', `const o = '${other}';\n`);

    // The second line has to be reachable — a `head -1` or a missing join would
    // leave every entry but the first silently unenforced.
    const r = run([]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('src/leak.ts:1');
  });

  it('lets the environment override the file (that is how CI supplies it)', () => {
    mkdirSync(join(dir, '.lynox'), { recursive: true });
    writeFileSync(join(dir, '.lynox', 'private-names.re'), 'never-appears-anywhere\n');
    commitFile('src/leak.ts', `const o = '${FICTIONAL_NAME}';\n`);

    expect(run([], { LYNOX_PRIVATE_NAMES_RE: FICTIONAL_NAME }).code).not.toBe(0);
  });

  it('treats a comments-only file as no pattern at all', () => {
    // A file holding nothing but comments collapses to an empty alternation, and
    // an empty pattern matches every line. It has to read as "absent" instead.
    mkdirSync(join(dir, '.lynox'), { recursive: true });
    writeFileSync(join(dir, '.lynox', 'private-names.re'), '# nothing yet\n\n');
    commitFile('src/ok.ts', 'export const x = 1;\n');

    expect(run([]).code).not.toBe(0); // fails closed…
    expect(run([OPT_OUT]).code).toBe(0); // …and does not light up the whole tree
  });

  it('treats an empty pattern as absent, not as "match everything"', () => {
    // An empty regex matches every line. Were the check `-z` on the wrong variable
    // — or the guard to run grep with an empty pattern — a clean tree would light
    // up entirely, and the natural fix would be to disable the class.
    commitFile('src/ok.ts', 'export const x = 1;\n');
    expect(run([], { LYNOX_PRIVATE_NAMES_RE: '' }).code).not.toBe(0);
    expect(run([OPT_OUT], { LYNOX_PRIVATE_NAMES_RE: '' }).code).toBe(0);
  });
});

/**
 * check-meta — commit messages and PR text. This is the surface where the leak has
 * actually happened, and the one that cannot be edited after a merge.
 */
describe('public-repo-guard — check-meta', () => {
  /** Commit `content` and return the SHA. */
  function commit(subject: string, content = 'x\n'): string {
    writeFileSync(join(dir, 'a.txt'), content);
    execFileSync('git', ['add', 'a.txt'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', subject], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t.t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t.t',
      },
    });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  }

  function runMeta(base: string, head: string, env: Record<string, string> = {}): Run {
    return run(['check-meta', base, head], { LYNOX_PRIVATE_NAMES_RE: FICTIONAL_NAME, ...env });
  }

  it('fires on a private name in a commit message, naming only the SHA', () => {
    const base = commit('Add the base file');
    const head = commit(`Fix the export for ${FICTIONAL_NAME}`, 'y\n');
    const r = runMeta(base, head);

    expect(r.code).not.toBe(0);
    // Same rule as the tree scan: the subject line carries the name, so `%s` must
    // not be printed the way no-ai-attribution.sh prints it.
    expect(r.out).not.toContain(FICTIONAL_NAME);
    expect(r.out).toContain(head.slice(0, 7));
  });

  it('scans only base..head, so an already-merged name cannot block every PR', () => {
    // The whole reason this walks a range: were it to scan all of history, one
    // name merged once would turn every future PR red, and the only way to ship
    // anything would be to bypass the gate.
    const base = commit(`An old commit about ${FICTIONAL_NAME}`);
    const head = commit('A clean follow-up', 'y\n');

    expect(runMeta(base, head).code).toBe(0);
  });

  it('fires on the PR body', () => {
    const base = commit('Add the base file');
    expect(runMeta(base, base, { PR_BODY: `reported by ${FICTIONAL_NAME}` }).code).toBe(1);
  });

  it('fires on the PR title', () => {
    const base = commit('Add the base file');
    expect(runMeta(base, base, { PR_TITLE: `Fix ${FICTIONAL_NAME} export` }).code).toBe(1);
  });

  it('reads the whole commit message, not just the subject', () => {
    // A name lands in a body ("as discussed with …") far more readily than in a
    // 72-character subject. Reading only `%s` passed every case here, because
    // every case put the name in the subject.
    const base = commit('Add the base file');
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'An ordinary subject', '-m', `Context: agreed with ${FICTIONAL_NAME} on Tuesday.`], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t' },
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    expect(runMeta(base, head).code).toBe(1);
  });

  it('scans every commit in the range, not only the newest', () => {
    // Truncating the loop to the tip passed every case, because every range here
    // held exactly one commit.
    const base = commit('Add the base file');
    commit(`A middle commit about ${FICTIONAL_NAME}`, 'y\n');
    const head = commit('A clean commit on top', 'z\n');

    expect(runMeta(base, head).code).toBe(1);
  });

  it('refuses an unresolvable range instead of reading it as empty', () => {
    // A base that is not in the clone — force-push, GC, a shallow CI checkout —
    // made rev-list fail into a swallowed stderr and the empty result read as
    // "no commit carries a name". That is a fail-open on the surface that cannot
    // be edited after a merge.
    const base = commit('Add the base file');
    const head = commit(`Fix for ${FICTIONAL_NAME}`, 'y\n');
    const absent = '0'.repeat(40);

    const r = runMeta(absent, head);
    expect(r.code).toBe(1);
    expect(r.out).toContain('cannot resolve');

    // And the clean path states how much it actually walked, which is the only
    // visible difference between "walked 1, found nothing" and "walked nothing".
    const clean = runMeta(base, head, { LYNOX_PRIVATE_NAMES_RE: 'nevermatchesanything' });
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('1 commit(s) scanned');
  });

  it('matches a name in a commit message case-insensitively', () => {
    const base = commit('Add the base file');
    const head = commit(`Fix for ${FICTIONAL_NAME_CAPITALISED}`, 'y\n');
    expect(runMeta(base, head).code).toBe(1);
  });

  it('passes on clean commits, title and body', () => {
    const base = commit('Add the base file');
    const head = commit('A perfectly ordinary change', 'y\n');
    const r = runMeta(base, head, { PR_TITLE: 'Ordinary change', PR_BODY: 'Nothing to see.' });

    expect(r.code).toBe(0);
  });

  it('fails closed without a pattern, and refuses a half-given range', () => {
    const base = commit('Add the base file');

    // Distinguishing 1 from 2 is the point: "not 0" was satisfied by a usage
    // error just as happily as by the refusal this case is named after, so the
    // exit contract in the script header was pinned by nothing.
    const r = run(['check-meta', base, base]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('LYNOX_PRIVATE_NAMES_RE');

    // A missing head must be a usage error (exit 2), not an empty range read as clean.
    expect(run(['check-meta', base], { LYNOX_PRIVATE_NAMES_RE: FICTIONAL_NAME }).code).toBe(2);
  });

  it('refuses a flag where a ref belongs, in either position', () => {
    // `check-meta --staged <sha>` used to be accepted with meta_base='--staged',
    // which is an unresolvable ref — and an unresolvable ref used to read as an
    // empty range, i.e. as clean.
    const base = commit('Add the base file');

    expect(run(['check-meta', '--staged', base], { LYNOX_PRIVATE_NAMES_RE: FICTIONAL_NAME }).code).toBe(2);
    expect(run(['check-meta', base, '--allow-missing-names'], { LYNOX_PRIVATE_NAMES_RE: FICTIONAL_NAME }).code).toBe(2);
  });
});
