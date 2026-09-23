/**
 * Tests for scripts/no-ai-attribution.sh.
 *
 * This guard strips AI self-attribution trailers from commit messages. Its first
 * version matched any line STARTING with `Claude-Session:` — and it silently ate a
 * line of prose in the very commit that introduced it, a body explaining the rule
 * ("Claude-Session:, no 'Generated with Claude Code'..."). A guard that fires on
 * obviously-safe lines is the failure it exists to prevent.
 *
 * So the contract has two halves, and both are load-bearing:
 *   - a real trailer is removed
 *   - prose that merely MENTIONS a trailer is not
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/no-ai-attribution.sh', import.meta.url));

let dir: string;
let msgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'no-ai-attr-'));
  msgPath = join(dir, 'COMMIT_EDITMSG');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the strip mode over `message` and return the rewritten file. */
function strip(message: string): string {
  writeFileSync(msgPath, message);
  execFileSync('bash', [SCRIPT, 'strip', msgPath], { encoding: 'utf-8' });
  return readFileSync(msgPath, 'utf-8');
}

describe('no-ai-attribution — strips the real trailers', () => {
  it('removes the Co-Authored-By: Claude trailer', () => {
    const out = strip(
      'Fix the thing\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n',
    );

    expect(out).not.toContain('noreply@anthropic.com');
    expect(out).toContain('Fix the thing');
  });

  it('removes the Claude-Session trailer', () => {
    const out = strip('Fix the thing\n\nClaude-Session: https://claude.ai/code/session_01QFhY\n');

    expect(out).not.toContain('claude.ai/code');
  });

  it('removes the "Generated with Claude Code" line', () => {
    const out = strip(
      'Fix the thing\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n',
    );

    expect(out).not.toContain('Generated with');
  });

  it('leaves a HUMAN Co-Authored-By alone', () => {
    const out = strip(
      'Fix the thing\n\nCo-Authored-By: Jane Doe <jane@example.com>\n' +
        'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n',
    );

    expect(out).toContain('Jane Doe <jane@example.com>');
    expect(out).not.toContain('anthropic.com');
  });
});

describe('no-ai-attribution — does not eat prose about the trailers', () => {
  // The regression that shipped: these lines START with the trailer words but are
  // ordinary sentences. The guard must leave them alone.
  it('keeps a line that begins with "Claude-Session:" but is prose', () => {
    const body = 'Claude-Session:, no "Generated with Claude Code". It was broken in 332 commits.';
    const out = strip(`Explain the rule\n\n${body}\n`);

    expect(out).toContain(body);
  });

  it('keeps a sentence that mentions Co-Authored-By: Claude mid-line', () => {
    const body = 'The rule forbids Co-Authored-By: Claude and the session link.';
    const out = strip(`Explain the rule\n\n${body}\n`);

    expect(out).toContain(body);
  });

  it('keeps a mid-line mention of generating with Claude Code', () => {
    const body = 'Someone wrote: Generated with Claude Code was the old trailer.';
    const out = strip(`Explain the rule\n\n${body}\n`);

    expect(out).toContain(body);
  });

  // The Co-Authored-By pattern has two halves — a line-start anchor and a
  // trailing address — and the sentence above is caught by both, so either
  // could be deleted without a test noticing. Each case here passes only one.
  it('keeps a mid-line quotation of the whole trailer, address included', () => {
    const body = 'The old default appended Co-Authored-By: Claude <noreply@anthropic.com>';
    const out = strip(`Explain the rule\n\n${body}\n`);

    expect(out).toContain(body);
  });

  it('keeps a line that begins with "Co-Authored-By: Claude" but carries no address', () => {
    const body = 'Co-Authored-By: Claude was the trailer the harness asked for.';
    const out = strip(`Explain the rule\n\n${body}\n`);

    expect(out).toContain(body);
  });

  it('leaves an untouched message byte-identical', () => {
    const message = 'Add a feature\n\nIt does the thing, for the reason.\n';

    expect(strip(message)).toBe(message);
  });
});

// The `check` verb, which the tests above never reached: they all drive `strip`,
// which takes a FILE. `check` takes a commit RANGE — a different door into the
// same script, and the one CI uses. It is a REQUIRED check in both repos.
//
// The defect these pin: `git rev-list "$base..$head"` sat in a `for` header with
// its stderr discarded, so the exit code belonged to the loop. An unresolvable
// base exits 128 with an empty list, the body never ran, and the function
// printed `clean ✓ (0 commits scanned)` and exited 0 — a green tick for a range
// it could not read.
describe('no-ai-attribution — when the search itself fails', () => {
  /** A `grep` on PATH that fails the way a missing file or a bad option does. */
  function withFailingGrep(code: number): { status: number | null; stderr: string } {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'grep'), `#!/usr/bin/env bash\nexit ${String(code)}\n`, { mode: 0o755 });
    const res = spawnSync('bash', [SCRIPT, 'strip', msgPath], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    });
    return { status: res.status, stderr: res.stderr };
  }

  const MESSAGE = 'Add a thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';

  it('leaves the message untouched, and says so on stderr', () => {
    // Before: the empty tmp file was copied over the message, git then refused an empty
    // one, and the abort named no cause — in a hook designed never to block.
    writeFileSync(msgPath, MESSAGE);
    const { status, stderr } = withFailingGrep(2);
    expect(status).toBe(0); // a hook that aborts teaches --no-verify; it must not
    expect(stderr).toMatch(/grep exited 2/);
    expect(readFileSync(msgPath, 'utf-8')).toBe(MESSAGE);
  });

  it('…and the control: the same message IS stripped when grep works', () => {
    // Without this, the case above passes for a message nothing would have changed.
    expect(strip(MESSAGE)).toBe('Add a thing\n');
  });

  it('ignores a leftover temp file instead of copying it over the message', () => {
    // Found by a refuter: with a FIXED temp path, a leftover from a hard interruption
    // that is also unwritable makes the redirect fail with 1 — not 2 — while the file
    // exists, so neither guard fires and `cat` reads somebody else's content over the
    // message, silently, exit 0. Reproduced against both the old code and the first
    // version of this fix. `mktemp` closes the class: the name cannot be left behind.
    writeFileSync(`${msgPath}.tmp`, 'STALE FROM AN INTERRUPTED RUN\n', { mode: 0o444 });
    expect(strip(MESSAGE)).toBe('Add a thing\n');
  }, 30_000);

  it('leaves the message alone when no temp file can be created at all', () => {
    writeFileSync(msgPath, MESSAGE);
    chmodSync(dir, 0o555);
    try {
      const res = spawnSync('bash', [SCRIPT, 'strip', msgPath], { encoding: 'utf-8' });
      expect(res.status).toBe(0); // still never blocks a commit
      expect(res.stderr).toMatch(/cannot create a temp file/);
      expect(readFileSync(msgPath, 'utf-8')).toBe(MESSAGE);
    } finally {
      chmodSync(dir, 0o755); // afterEach cannot remove a read-only directory
    }
  }, 30_000);

  it('treats "no line survived" as the answer it is, not as a failure', () => {
    // `grep -v` exits 1 when everything matched. That is legitimate — a message made
    // only of trailers has nothing left — so the bail-out must not swallow exit 1.
    expect(strip('Co-Authored-By: Claude <noreply@anthropic.com>\n')).toBe('\n');
  });
});

describe('no-ai-attribution — the range it was asked to scan', () => {
  let repo: string;

  const GIT_ID = {
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e',
  } as const;

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', env: { ...process.env, ...GIT_ID } }).trim();
  }

  /** Run `check base head`; return the exit code and the merged output. */
  function check(base: string, head: string): { code: number; out: string } {
    try {
      const out = execFileSync('bash', [SCRIPT, 'check', base, head], { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'lynox-noai-'));
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'base');
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  const UNRESOLVABLE = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  it('⭐ THE POINT: the same commit cannot pass by making the base unreadable', () => {
    const base = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'add thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const head = git('rev-parse', 'HEAD');

    // Identical substrate on both sides — only the base differs. Without that
    // pairing a passing case proves nothing about whether the scan ran.
    expect(check(base, head).code, 'resolvable base must still catch the trailer').toBe(1);

    const blind = check(UNRESOLVABLE, head);
    expect(blind.code, 'an unreadable range must refuse, not report clean').toBe(2);
    expect(blind.out).toContain('could not enumerate');
    // `clean ✓`, not the word "clean": the refusal itself says "refusing to report
    // a CLEAN range", so barring the bare word failed against a correct message.
    expect(blind.out).not.toContain('clean ✓');
    expect(blind.out).not.toContain('commits scanned');
  });

  it('exit 2 is neither "clean" nor "found something" — and names the cause', () => {
    const head = git('rev-parse', 'HEAD');
    const r = check(UNRESOLVABLE, head);
    expect(r.code).toBe(2);
    expect(r.out).toContain('Refusing to report a clean range this check could not read');
    // git's own words are passed through, so the reader sees WHICH end failed.
    expect(r.out).toMatch(/Invalid revision range|unknown revision|ungültig|Schwerwiegend/i);
  });

  // A foreign mutation round walked through three doors this block did not cover.
  // None was a defect — the script already behaved correctly in all three — but an
  // uncovered correct behaviour is a deletable one.

  // Narrowing the refusal to `status -eq 128` survived every test above, because
  // 128 is the only status the fixture can produce. Under any other failure the
  // narrowed version walks git's ERROR MESSAGE as if its words were SHAs and
  // reports them as commits scanned.
  it('any failed enumeration refuses — not only the one status the fixture produces', () => {
    const bin = join(repo, 'stub-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'git'),
      '#!/bin/sh\nif [ "$1" = "rev-list" ]; then echo "error: some other failure mode" >&2; exit 129; fi\nexec /usr/bin/git "$@"\n',
      { encoding: 'utf-8', mode: 0o755 });
    let code = 0; let out = '';
    try {
      out = execFileSync('bash', [SCRIPT, 'check', 'aaa', 'bbb'],
        { cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? -1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(code, 'a non-128 failure must refuse too').toBe(2);
    expect(out).toContain('could not enumerate');
    expect(out).not.toContain('commits scanned');
  });

  // The sibling guard's harness probe is a deliberately HALF-given range and its
  // exemption argues for that choice; this script's probe passes no arguments at
  // all, so the half-range door was unpinned on the very guard whose range door
  // this change fixes. `check main` resolves `main..` as `main..HEAD` — a walk
  // that succeeds and answers for the wrong range.
  it('half a range is refused, not silently completed from HEAD', () => {
    let code = 0; let out = '';
    try {
      out = execFileSync('bash', [SCRIPT, 'check', 'main'], { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? -1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(code).toBe(2);
    expect(out).toContain('usage:');
    expect(out).not.toContain('commits scanned');
  });

  // The refusal belongs on stderr, where a caller that pipes stdout still sees it.
  // On stdout it lands in the same stream as `clean ✓`, which is the stream a
  // reader scans for the verdict.
  it('the refusal goes to stderr, not into the stream that carries the verdict', () => {
    const head = git('rev-parse', 'HEAD');
    let stdout = ''; let stderr = '';
    try {
      execFileSync('bash', [SCRIPT, 'check', UNRESOLVABLE, head], { cwd: repo, encoding: 'utf-8', stdio: 'pipe' });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      stdout = e.stdout ?? ''; stderr = e.stderr ?? '';
    }
    expect(stderr).toContain('Refusing to report a clean range');
    expect(stdout).not.toContain('Refusing to report a clean range');
  });

  // The enumeration can succeed and a single commit still be unreadable (missing
  // object, shallow gap). `git show … | grep -q` gave grep an empty stream, grep
  // answered "no match", and a trailer-bearing commit counted as scanned and
  // clean. Only `show` fails here, and only for the commit that carries the
  // trailer — the one whose loss the verdict would hide.
  it('a commit that cannot be read mid-walk refuses, instead of counting as clean', () => {
    const base = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'add thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    const head = git('rev-parse', 'HEAD');
    const bin = join(repo, 'stub-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = "show" ]; then for a in "$@"; do [ "$a" = "${head}" ] && { echo "fatal: bad object ${head}" >&2; exit 128; }; done; fi\nexec /usr/bin/git "$@"\n`,
      { encoding: 'utf-8', mode: 0o755 });
    let code = 0; let out = '';
    try {
      out = execFileSync('bash', [SCRIPT, 'check', base, head],
        { cwd: repo, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? -1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(code, 'an unreadable commit must refuse, not pass as clean').toBe(2);
    expect(out).toContain('could not read commit');
    expect(out).not.toContain('clean ✓');
  });

  it('a range that resolves and is empty still passes, with a real count', () => {
    const base = git('rev-parse', 'HEAD');
    const r = check(base, base);
    expect(r.code).toBe(0);
    expect(r.out).toContain('0 commits scanned');
  });

  // ⚠ Named for what it checks, not for what the change did. Replacing the counter
  // with the old `$(git rev-list --count … || echo 0)` survives this suite, and
  // reasoning says it must: once the enumeration above is status-checked, the
  // range always resolves, so a second query cannot fail while the first
  // succeeded — the `|| echo 0` fallback became unreachable rather than wrong.
  // An EQUIVALENT mutant, argued rather than assumed; no fixture separates them.
  // The counter change is tidying (it deletes a dead fail-open), and calling this
  // test its guard would be a coverage claim nothing backs.
  it('the count matches the range that was actually walked', () => {
    const base = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    const r = check(base, git('rev-parse', 'HEAD'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 commits scanned');
  });
});
