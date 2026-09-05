/**
 * The wrap-list block of `scripts/security-scan.sh`.
 *
 * The list is hardcoded, and the existence test used to sit INSIDE the grep
 * condition (`[ -f "$file" ] && ! grep …`). A member that no longer existed
 * therefore dropped out of the set silently, and the loop went on to print
 * "✓ External tools wrap untrusted content" — a tick for a set one file short of
 * what it named. Measured 2026-09-05: six of seven paths existed, and
 * `src/integrations/google/google-gmail.ts` had gone with its tool in 1a5eacbd
 * (#180) four months earlier.
 *
 * Driven against the REAL script, from a fixture tree, so the assertions cover
 * the shipped file rather than a re-implementation of its loop. The refusal fires
 * well before the `pnpm audit` at the end, so these stay fast and offline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/security-scan.sh', import.meta.url));

/** Every path the wrap loop names, in the order the script lists them. */
const WRAPPED = [
  'src/tools/builtin/http.ts',
  'src/integrations/search/web-search-tool.ts',
  'src/integrations/google/google-sheets.ts',
  'src/integrations/google/google-drive.ts',
  'src/integrations/google/google-calendar.ts',
  'src/integrations/google/google-docs.ts',
];

describe('security-scan — a list member that vanishes must not vanish from the check', () => {
  let root: string;

  function write(rel: string, body: string): void {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, 'utf-8');
  }

  function run(): { code: number; out: string } {
    try {
      const out = execFileSync('sh', [SCRIPT], { cwd: root, encoding: 'utf-8', stdio: 'pipe' });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lynox-secscan-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** A tree where every wrapped file exists and wraps, minus the ones named. */
  function fixture(omit: readonly string[] = []): void {
    for (const rel of WRAPPED) {
      if (omit.includes(rel)) continue;
      write(rel, 'export const x = wrapUntrustedData("body");\n');
    }
  }

  it('⭐ THE POINT: a missing member is refused, not skipped', () => {
    fixture(['src/integrations/google/google-docs.ts']);
    const r = run();
    expect(r.code, 'exit 2 — could not run, which is neither clean nor a finding').toBe(2);
    expect(r.out).toContain('is in the wrap list but does not exist');
    // The tick must NOT have been printed for a set that was one file short.
    expect(r.out).not.toContain('External tools wrap untrusted content');
    // Nor may it report a FINDING for the same absent file. Checking existence
    // after the grep produces both lines at once — correct exit code, correct
    // refusal text, and a fabricated wrapping violation against a file that is
    // not there. That conflates exactly the two facts this refusal exists to keep
    // apart: "could not run" and "found something".
    expect(r.out).not.toContain('missing wrapUntrustedData');
  });

  // `-f`, not `-e`: a directory where a source file belongs is a stale list, not a
  // wrapping finding. With `-e` the entry passes the existence test and the grep
  // then reports it as unwrapped ("Is a directory").
  it('a directory in a source file position is staleness, not a finding', () => {
    fixture(['src/integrations/google/google-docs.ts']);
    mkdirSync(join(root, 'src/integrations/google/google-docs.ts'), { recursive: true });
    const r = run();
    expect(r.code).toBe(2);
    expect(r.out).toContain('is in the wrap list but does not exist');
    expect(r.out).not.toContain('missing wrapUntrustedData');
  });

  it('every member is load-bearing, not just the one that happened to go', () => {
    // The first cut of this defect was found through ONE removed path. Checking a
    // single member would pass with the guard weakened for all the others.
    for (const rel of WRAPPED) {
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), 'lynox-secscan-'));
      fixture([rel]);
      const r = run();
      expect(r.code, `${rel} must be refused when absent`).toBe(2);
      expect(r.out, rel).toContain(rel);
    }
  });

  it('the control: a complete list gets past the wrap loop', () => {
    fixture();
    const r = run();
    // It still fails LATER (this fixture has no worker-loop.ts for the SSRF check),
    // and that is the point of the assertion: exit 1 is "found something", exit 2
    // is "could not run". Without this the test above would pass on a script that
    // refuses everything.
    expect(r.code, 'a complete list must not produce the could-not-run refusal').not.toBe(2);
    expect(r.out).toContain('External tools wrap untrusted content');
  });

  it('a member that exists but does not wrap is still a FINDING, not a refusal', () => {
    fixture();
    write('src/tools/builtin/http.ts', 'export const x = "no wrapping here";\n');
    const r = run();
    expect(r.code).not.toBe(2);
    expect(r.out).toContain('missing wrapUntrustedData or wrapChannelMessage');
    // And the tick must be absent — the symmetric assertion the missing-member
    // test already makes. Dropping `WRAP_OK=false` prints the ❌ and the ✓ one
    // after the other, and only this line notices.
    expect(r.out).not.toContain('External tools wrap untrusted content');
  });
});
