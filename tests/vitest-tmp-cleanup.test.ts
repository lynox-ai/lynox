import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, chmodSync, readFileSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sweepStaleVitestTmp, isVitestTmpCache, newestFileMtime, STALE_MS,
  foreignVitestPids, otherVitestRunning,
} from '../scripts/vitest-tmp-cleanup.js';

/** These tests are about the shape and age rules; the liveness guard has its own block. */
const NO_OTHERS = (): boolean => false;

/**
 * The sweep runs UNATTENDED on every test run, in a directory shared with every
 * other tool on the machine, and it deletes. So each witness below is about what it
 * must NOT reach, except the first.
 *
 * Written after the author deleted a running run's cache by hand: the gate existed
 * and was skipped for a case that felt obvious. These are the gate as code.
 */

const NANO_A = 'aaaaaaaaaaaaaaaaaaaaa'; // 21 chars, the nanoid shape
const NANO_B = 'bbbbbbbbbbbbbbbbbbbbb';
const NOW = 1_800_000_000_000;
const old = (ms: number): number => (NOW - ms) / 1000;

function cache(root: string, name: string, fileAgeMs: number | null): string {
  const p = join(root, name);
  mkdirSync(join(p, 'ssr'), { recursive: true });
  if (fileAgeMs !== null) {
    const f = join(p, 'ssr', 'deadbeef');
    writeFileSync(f, 'x');
    utimesSync(f, old(fileAgeMs), old(fileAgeMs));
  }
  return p;
}

describe('sweepStaleVitestTmp', () => {
  it('⛔ removes a corpse whose newest file is older than the threshold', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const p = cache(root, NANO_A, 3 * 60 * 60 * 1000);
      const logged: string[] = [];
      const removed = sweepStaleVitestTmp(root, NOW, STALE_MS, (m) => logged.push(m), NO_OTHERS);
      expect(removed).toEqual([p]);
      expect(existsSync(p)).toBe(false);
      // Says what it did, with the path and the age — the one loud part.
      expect(logged[0]).toContain(p);
      expect(logged[0]).toMatch(/180 min old/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('⛔ keeps an OLD directory that holds a FRESH file — the live long-runner', () => {
    // The case that makes the directory's own mtime unusable: a dir mtime changes
    // when an entry is added or removed, not when a file in it is written. A run
    // that keeps appending leaves the parent looking as old as its creation.
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const p = cache(root, NANO_A, 60 * 1000);
      utimesSync(p, old(5 * 60 * 60 * 1000), old(5 * 60 * 60 * 1000)); // parent: 5h old
      expect(sweepStaleVitestTmp(root, NOW, STALE_MS, () => {}, NO_OTHERS)).toEqual([]);
      expect(existsSync(p)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('⛔ keeps a directory with no file at all — freshly created, nothing to judge', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const p = cache(root, NANO_A, null);
      utimesSync(p, old(9 * 60 * 60 * 1000), old(9 * 60 * 60 * 1000));
      expect(sweepStaleVitestTmp(root, NOW, STALE_MS, () => {}, NO_OTHERS)).toEqual([]);
      expect(existsSync(p)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('⛔ keeps every FOREIGN shape, however old', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const kept: string[] = [];
      // A name that is not the nanoid shape.
      kept.push(cache(root, 'ds-test-03m8qH', 9 * 60 * 60 * 1000));
      kept.push(cache(root, 'aaaaaaaaaaaaaaaaaaaaaa', 9 * 60 * 60 * 1000)); // 22 chars
      kept.push(cache(root, 'aaaaaaaaaaaaaaaaaaaa', 9 * 60 * 60 * 1000)); // 20 chars
      // Right name, but a SECOND child — not ours.
      const two = cache(root, NANO_B, 9 * 60 * 60 * 1000);
      mkdirSync(join(two, 'client'));
      kept.push(two);
      // Right name, but the single child is a FILE called ssr.
      const fileChild = join(root, 'ccccccccccccccccccccc');
      mkdirSync(fileChild);
      writeFileSync(join(fileChild, 'ssr'), 'x');
      utimesSync(join(fileChild, 'ssr'), old(9 * 60 * 60 * 1000), old(9 * 60 * 60 * 1000));
      kept.push(fileChild);

      expect(sweepStaleVitestTmp(root, NOW, STALE_MS, () => {}, NO_OTHERS)).toEqual([]);
      for (const p of kept) expect(existsSync(p), p).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('⛔ keeps a single directory child whose name is NOT ssr', () => {
    // A refuter mutant that dropped `children[0].name === 'ssr'` survived the whole
    // file: every foreign case had either a wrong NAME or two children, so nothing
    // covered "one child, right shape, wrong name". `<nanoid>/dist/` would have gone.
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const p = join(root, NANO_A);
      mkdirSync(join(p, 'dist'), { recursive: true });
      const f = join(p, 'dist', 'x');
      writeFileSync(f, 'x');
      utimesSync(f, old(9 * 60 * 60 * 1000), old(9 * 60 * 60 * 1000));
      expect(isVitestTmpCache(root, NANO_A)).toBe(false);
      expect(sweepStaleVitestTmp(root, NOW, STALE_MS, () => {}, NO_OTHERS)).toEqual([]);
      expect(existsSync(p)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('⛔ keeps a second child that sorts AFTER ssr — not only one that sorts before', () => {
    // The existing two-children case used `client`, which `readdirSync` returns BEFORE
    // `ssr`, so the name check caught it and the LENGTH check was never exercised. A
    // mutant relaxing `length === 1` to `>= 1` therefore survived. With `zzz`, `ssr`
    // comes first and only the count can refuse it.
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const p = join(root, NANO_A);
      mkdirSync(join(p, 'ssr'), { recursive: true });
      mkdirSync(join(p, 'zzz'));
      const f = join(p, 'ssr', 'x');
      writeFileSync(f, 'x');
      utimesSync(f, old(9 * 60 * 60 * 1000), old(9 * 60 * 60 * 1000));
      expect(readdirSync(p).sort()[0], 'ssr really does come first here').toBe('ssr');
      expect(isVitestTmpCache(root, NANO_A)).toBe(false);
      expect(sweepStaleVitestTmp(root, NOW, STALE_MS, () => {}, NO_OTHERS)).toEqual([]);
      expect(existsSync(p)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('⛔ pins the threshold VALUE, and both sides of it', () => {
    // Tests used 1-minute and 3-hour files, so shrinking the constant to 30 or even 2
    // minutes changed nothing visible — a mutant that would sweep live caches.
    expect(STALE_MS).toBe(2 * 60 * 60 * 1000);
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const younger = cache(root, NANO_A, 110 * 60 * 1000); // just under two hours
      const older = cache(root, NANO_B, 130 * 60 * 1000); // just over
      expect(sweepStaleVitestTmp(root, NOW, STALE_MS, () => {}, NO_OTHERS)).toEqual([older]);
      expect(existsSync(younger), 'under the threshold stays').toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('⛔ removes the corpse and NOTHING beside it in the same root', () => {
    // A mutant that also removed the whole root survived: no case had a neighbour.
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const corpse = cache(root, NANO_A, 9 * 60 * 60 * 1000);
      const neighbour = join(root, 'someone-elses-dir');
      mkdirSync(neighbour);
      writeFileSync(join(neighbour, 'keep'), 'x');
      expect(sweepStaleVitestTmp(root, NOW, STALE_MS, () => {}, NO_OTHERS)).toEqual([corpse]);
      expect(existsSync(root), 'the root itself').toBe(true);
      expect(existsSync(join(neighbour, 'keep')), 'the neighbour').toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('⛔ refuses a SYMLINK, even one pointing at a matching directory', () => {
    // Measured before the fix: `statSync` follows a link, so a 21-character symlink
    // whose target held only `ssr/` with an old file inside passed the check and the
    // sweep unlinked it. `rmSync(…, { recursive: true })` does not recurse into a
    // target, so the target survived — but removing a link this sweep did not create
    // is reaching outside what it made. `lstatSync` makes a link not-a-directory.
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const target = join(root, 'target');
      mkdirSync(join(target, 'ssr'), { recursive: true });
      const f = join(target, 'ssr', 'precious');
      writeFileSync(f, 'keep me');
      utimesSync(f, old(5 * 60 * 60 * 1000), old(5 * 60 * 60 * 1000));
      const link = join(root, NANO_A);
      symlinkSync(target, link);

      expect(isVitestTmpCache(root, NANO_A), 'a symlink is not one of ours').toBe(false);
      expect(sweepStaleVitestTmp(root, NOW, STALE_MS, () => {}, NO_OTHERS)).toEqual([]);
      expect(lstatSync(link).isSymbolicLink(), 'the link survives').toBe(true);
      expect(existsSync(f), 'and so does its target').toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('⛔ an unreadable entry does not throw — the sweep is hygiene, not a gate', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const p = cache(root, NANO_A, 9 * 60 * 60 * 1000);
      chmodSync(p, 0o000);
      expect(() => sweepStaleVitestTmp(root, NOW, STALE_MS, () => {}, NO_OTHERS)).not.toThrow();
    } finally {
      try { chmodSync(join(root, NANO_A), 0o700); } catch { /* best effort */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a missing root is not an error either', () => {
    expect(sweepStaleVitestTmp(join(tmpdir(), 'sweep-does-not-exist-0000'), NOW, STALE_MS, () => {}, NO_OTHERS)).toEqual([]);
  });

  it('the threshold is a parameter: the same corpse survives a longer one', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const p = cache(root, NANO_A, 3 * 60 * 60 * 1000);
      expect(sweepStaleVitestTmp(root, NOW, 4 * 60 * 60 * 1000, () => {}, NO_OTHERS)).toEqual([]);
      expect(existsSync(p)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('the two predicates, separately', () => {
  it('newestFileMtime reads the newest FILE, recursively, and null when there is none', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      mkdirSync(join(root, 'a', 'b'), { recursive: true });
      expect(newestFileMtime(root)).toBeNull();
      const oldF = join(root, 'a', 'old');
      const newF = join(root, 'a', 'b', 'new');
      writeFileSync(oldF, 'x'); writeFileSync(newF, 'x');
      utimesSync(oldF, old(9 * 60 * 60 * 1000), old(9 * 60 * 60 * 1000));
      utimesSync(newF, old(60 * 1000), old(60 * 1000));
      expect(Math.round((NOW - newestFileMtime(root)!) / 60000)).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('isVitestTmpCache needs BOTH the name shape and the single ssr child', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      cache(root, NANO_A, 0);
      expect(isVitestTmpCache(root, NANO_A)).toBe(true);
      cache(root, 'ds-test-03m8qH', 0);
      expect(isVitestTmpCache(root, 'ds-test-03m8qH')).toBe(false);
      mkdirSync(join(root, NANO_B));
      expect(isVitestTmpCache(root, NANO_B), 'no ssr child at all').toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});


describe('the order in the globalSetup, which the sweep depends on', () => {
  // ⚠ A SOURCE assertion, and weaker than a wire test — said plainly. The wire test
  // would have to call `setup()`, which shells out to `svelte-kit sync`; too heavy to
  // run for an ordering claim. The behavioural proof exists and was run by hand: a
  // corpse planted in the REAL temp dir is gone after `npx vitest run`, which could
  // not happen if the sweep were scanning the post-redirect run root.
  //
  // What this kills: moving the sweep below the redirect, or dropping the explicit
  // argument so it defaults to `tmpdir()` — which, after the redirect, is this run's
  // own empty root.
  const SETUP = join(import.meta.dirname, '../scripts/vitest-global-setup.ts');

  it('⛔ sweeps the real OS temp dir BEFORE the TMPDIR redirect moves it', () => {
    // ⚠ Comment lines are stripped FIRST. The previous version searched the raw file
    // and matched the setup's own documentation — the paragraph that explains the
    // ordering names `redirectTmpdirForRun()` in prose — so it reported the redirect
    // as coming first and failed against a correct file. A check that cannot tell the
    // thing from the discussion of the thing is not a check. (Second time today.)
    const code = readFileSync(SETUP, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    // ⚠ EXACTLY ONE call, because a refuter defeated the first version with a dead one:
    // `if (false) sweepStaleVitestTmp(osTmp0);` before the redirect and the real call
    // after it satisfied an index comparison. Counting closes that, and the count is the
    // honest limit of a source check — it cannot see whether the call RUNS.
    const calls = code.split('sweepStaleVitestTmp(').length - 1;
    expect(calls, 'one call, so a dead decoy cannot satisfy the order').toBe(1);
    const sweepAt = code.indexOf('sweepStaleVitestTmp(');
    const redirectAt = code.indexOf('redirectTmpdirForRun()', code.indexOf('export default'));
    expect(sweepAt, 'the sweep is called at all').toBeGreaterThan(-1);
    expect(redirectAt, 'the redirect is called at all').toBeGreaterThan(-1);
    expect(sweepAt, 'the sweep must come first').toBeLessThan(redirectAt);
  });

  it('⛔ passes the temp dir EXPLICITLY, so a later redirect cannot change what it scans', () => {
    const src = readFileSync(SETUP, 'utf8');
    // These two are code shapes that no comment in this file writes, so the raw read is safe here.
    // Captured before the redirect and handed in — not left to the default.
    expect(src).toMatch(/const osTmp = tmpdir\(\);/);
    expect(src).toMatch(/sweepStaleVitestTmp\(osTmp\)/);
  });
});


describe('the liveness guard — an age test cannot see an IDLE live run', () => {
  const PS = [
    '    1       0 /sbin/init',
    '  100       1 node /x/node_modules/vitest/vitest.mjs run',   // another session's run
    '  200       1 node /y/node_modules/vitest/vitest.mjs run',   // ours (self)
    '  201     200 node .../vitest/dist/workers/forks.js',        // our worker
    '  300     999 bash -c grep vitest something',                // not a vitest process
  ].join('\n');

  it('⛔ counts another run as foreign, and our own worker and parent as ours', () => {
    expect(foreignVitestPids(PS, 200)).toEqual([100]);
    // The observer in the fixture (`bash -c grep vitest …`) must NOT count: it would
    // stand the sweep down for as long as somebody greps for the word. Found by writing
    // this very test — the first version reported it as a run.
    expect(foreignVitestPids(PS, 200)).not.toContain(300);
    // But a bare launcher DOES count. Over-inclusive on purpose: one too many costs
    // disk, one too few costs somebody's run.
    expect(foreignVitestPids('  400       1 npm exec vitest run', 999)).toEqual([400]);
    // From inside a worker, the run's own main process is an ANCESTOR. Counting only
    // downwards reported our own parent as foreign, which would have stood the sweep
    // down forever — every run would have skipped.
    expect(foreignVitestPids(PS, 201)).toEqual([100]);
  });

  it('⛔ FAILS CLOSED when ps cannot be read — the one place this file is not fail-open', () => {
    expect(otherVitestRunning(1, () => { throw new Error('no ps'); })).toBe(true);
    expect(otherVitestRunning(200, () => PS)).toBe(true);
    expect(otherVitestRunning(200, () => '    1       0 /sbin/init')).toBe(false);
  });

  it('⛔ skips the sweep entirely while another run is alive, and SAYS so', () => {
    // The hazard: vitest writes each cache file once, memoises the path, and remembers
    // the directory in a Set it never re-checks — so a run idle for two hours has an old
    // newest-file mtime and is still live. Deleting its cache gives it ENOENT.
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const p = cache(root, NANO_A, 9 * 60 * 60 * 1000);
      const logged: string[] = [];
      const removed = sweepStaleVitestTmp(root, NOW, STALE_MS, (m) => logged.push(m), () => true);
      expect(removed).toEqual([]);
      expect(existsSync(p), 'the corpse waits for a quiet moment').toBe(true);
      expect(logged[0], 'a silent skip is indistinguishable from finding nothing')
        .toMatch(/another vitest is running/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a NaN clock deletes nothing, rather than everything', () => {
    // `NaN < staleMs` is false, so every directory read as stale. Production passes
    // `Date.now()`; this guards the exported API.
    const root = mkdtempSync(join(tmpdir(), 'sweep-'));
    try {
      const p = cache(root, NANO_A, 60 * 1000);
      expect(sweepStaleVitestTmp(root, Number.NaN, STALE_MS, () => {}, NO_OTHERS)).toEqual([]);
      expect(existsSync(p)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
