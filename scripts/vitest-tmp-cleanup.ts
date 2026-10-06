import { readdirSync, statSync, lstatSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Remove the transform-cache directories that killed Vitest runs leave in the OS
 * temp dir.
 *
 * WHY THEY EXIST AT ALL. Vitest 4's `ModuleFetcher` writes each transformed module
 * to `join(<tmpdir>/<nanoid>, <environment>)` — so `/tmp/<nanoid>/ssr/<sha1>` for
 * node tests. Its own comment says what for: "primarily used by the forks pool to
 * avoid using `process.send(bigBuffer)`". Both repos run `pool: 'forks'`, so every
 * run of ours takes that path. Measured 2026-10-06 on a full core run: up to three
 * such directories alive at once, 52 MB in total at peak.
 *
 * WHY THEY SURVIVE. `TestProject.close()` calls `clearTmpDir()`, which removes the
 * project's own directory — so a run that ends normally cleans up, observed directly
 * (1077 files → 0 inside 45 seconds). ⚠ Narrower than it sounds, and a refuter was
 * right to say so: a non-root project built by `initializeProject` mints its OWN
 * `join(tmpdir(), nanoid())` rather than sharing the instance's, so "close removes it"
 * is a statement about each project's own directory and not a proof that none is left.
 * This repo's config declares no `projects`, so that case is not live here. A run that is KILLED never reaches `close()`, and on this
 * machine that is not hypothetical: the kernel log carried 125 OOM lines on the day
 * this was written. `/tmp` is a tmpfs, so a leftover sits in RAM and makes the next
 * kill more likely — the leak is a consequence of memory pressure first and a cause
 * of it second.
 *
 * ⛔ WHY NOT `TMPDIR` INSTEAD, since moving the cache to disk looks simpler. It
 * cannot be set from here: `createVitest` constructs `new Vitest(...)` BEFORE it
 * even locates the config file, and `_tmpDir = join(tmpdir(), nanoid())` is a class
 * field, so it is fixed before `vitest.config.ts` is imported and long before a
 * `globalSetup` runs. The only lever is the process environment — and that covers
 * the wrong runs: core's CI calls `pnpm exec vitest run --coverage` and a developer
 * types `npx vitest run`, both of which bypass any `package.json` script. A
 * `globalSetup` runs for EVERY invocation whatever the entry point, which is why
 * the sweep lives here and not in an env var.
 *
 * ⛔ WHY AN AGE TEST IS NOT ENOUGH, found by a refuter and the reason this file also
 * asks who is running. Vitest writes each cache file ONCE: the path is memoised on the
 * transform result (`_vitest_tmp`), the directory is remembered in an in-memory Set and
 * never re-checked, and `atomicWriteFile` writes into `dirname(...)` with no `mkdir`.
 * So a run whose files are all older than the threshold — one that transformed
 * everything in its first seconds, or a watch session idle for two hours — is STILL
 * LIVE, and removing its cache gives it ENOENT on the next transform and a missing file
 * on the next worker read. The newest-FILE test protects a busy run; it does not protect
 * an idle one. Hence `otherVitestRunning()`: while any vitest outside this process tree
 * is alive, the sweep does nothing at all and says so. Corpses then wait for a quiet
 * moment, which is the cheap half of the trade.
 *
 * ⚠ WHAT THIS DOES NOT DO: it does not stop the leak. It bounds how long a corpse
 * occupies RAM. The leak itself is upstream.
 *
 * ⚠ AND IT IS NOT THE SAME THING AS A `TMPDIR` REDIRECT, which the sibling repo does
 * carry (`packages/managed/src/ci/test-run-tmpdir.ts`, 2026-10-02). That redirect
 * works and solves a REAL and different leak: a fixture calling
 * `mkdtempSync(join(tmpdir(), …))` DURING a test reads the variable at that moment,
 * so it lands under a per-run root that the teardown removes. Vitest's own cache
 * cannot be moved that way, because `_tmpDir` is already fixed when `globalSetup`
 * runs — so a run with that redirect in place still leaves this directory in the
 * real temp dir. The two measures are complements, not alternatives, and a future
 * reader who replaces this sweep with a redirect will move the fixtures and keep the
 * cache.
 *
 * ⚠ CORRECTION TO AN EARLIER VERSION OF THIS PARAGRAPH, kept because the mistake is
 * instructive. It said core did NOT carry that redirect and never had — measured with
 * `grep` and `git log -S TMPDIR`. Both were run in the SHARED `core/` checkout, which
 * sat on an older commit than `origin/main`: core carries the redirect, in
 * `scripts/vitest-global-setup.ts` beside this sweep, and the sibling repo's claim was
 * right. Writing an edit on top of that stale read also clobbered the redirect and
 * failed four of its tests — caught by the suite, not by me. A measurement against a
 * checkout is a measurement of that checkout.
 *
 * ⛔ Because the redirect exists, the ORDER matters: this sweep must run BEFORE it. The
 * redirect points `process.env.TMPDIR` at a per-run root, so `tmpdir()` after it is a
 * directory that cannot hold a corpse. The caller passes the real OS temp dir
 * explicitly, and a test pins that it does.
 *
 * This sweep is machine-wide by construction: it scans `tmpdir()`, not the repo, so
 * it removes a corpse whatever created it — including the sibling repo's, whenever a
 * run here happens.
 */

/** `nanoid()`'s default: 21 characters of the URL-safe alphabet. */
const NANOID = /^[A-Za-z0-9_-]{21}$/;

/** Two hours. A full core run took under five minutes when this was written. */
export const STALE_MS = 2 * 60 * 60 * 1000;

/**
 * The newest mtime of any FILE inside, or null when there is no file at all.
 *
 * ⛔ NOT the directory's own mtime, and the difference is the whole safety of this
 * sweep: a directory's mtime changes when an ENTRY is created or removed, not when
 * a file inside it is written. A run that keeps appending to `ssr/` therefore leaves
 * the PARENT's mtime at its creation time — which is exactly how two live caches
 * came to look 97 minutes old while they were still being written to, and why
 * judging by the parent would delete a running run's cache.
 *
 * `null` (no files) means KEEP: a directory that has just been created and not yet
 * written to is the freshest thing there is, and it has no mtime to judge.
 */
export function newestFileMtime(dir: string): number | null {
  let newest: number | null = null;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        const m = statSync(p).mtimeMs;
        if (newest === null || m > newest) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

/**
 * Is this entry one of OUR caches — exactly `<nanoid>/` holding only `ssr/`?
 *
 * Deliberately narrow on both halves. `/tmp` is shared with every other tool on
 * the machine, and a sweep that runs unattended on every test run must not be able
 * to reach something it did not create. A name that merely looks random, or a
 * directory with a second child, is left alone even if it costs us a corpse.
 */
export function isVitestTmpCache(root: string, name: string): boolean {
  if (!NANOID.test(name)) return false;
  const p = join(root, name);
  // ⛔ `lstatSync`, NOT `statSync`, and this is a deletion path so the difference is
  // worth the line. `statSync` FOLLOWS a symlink: measured, a 21-character symlink
  // pointing at a directory whose only child is `ssr/` passed the check, and the sweep
  // then unlinked the symlink. Node's `rmSync(…, { recursive: true })` does not recurse
  // into a link target, so nothing was destroyed — but removing a link this sweep did
  // not create is still reaching outside what it made. With `lstatSync` a symlink is
  // not a directory and the question does not arise.
  if (!lstatSync(p).isDirectory()) return false;
  const children = readdirSync(p, { withFileTypes: true });
  return children.length === 1 && children[0]!.name === 'ssr' && children[0]!.isDirectory();
}

/**
 * The pids of vitest processes that are NOT this process or one of its descendants.
 *
 * Pure over `ps` output so it can be tested without a second vitest on the machine.
 *
 * A pid counts as OURS in BOTH directions — our descendants and our ancestors. The
 * descendants are the forked workers of this very run. The ancestors matter because the
 * same function is exercised from inside a worker, where the run's own main process is
 * an ancestor rather than a child; counting only downwards made this report our own
 * parent as a foreign run, which would have stood the sweep down permanently.
 */
export function foreignVitestPids(psOutput: string, selfPid: number): number[] {
  const rows: Array<{ pid: number; ppid: number; cmd: string }> = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! });
  }
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  /** Does walking up from `from` reach `target`? Bounded: a corrupt table could loop. */
  const reaches = (from: number, target: number): boolean => {
    for (let p = from, hops = 0; p > 1 && hops < 64; p = parent.get(p) ?? 0, hops++) {
      if (p === target) return true;
    }
    return false;
  };
  const isOurs = (pid: number): boolean => reaches(pid, selfPid) || reaches(selfPid, pid);
  // ⚠ DELIBERATELY OVER-INCLUSIVE on what counts as a run, because the two error
  // directions are not symmetric: counting one too many makes the sweep stand down
  // (costs disk), counting one too few deletes a live cache (costs a run). So a bare
  // `npm exec vitest run` counts, not only a resolved `…/vitest/vitest.mjs`.
  //
  // The one narrowing: tools whose JOB is to carry other names in their arguments. A
  // refuter's fixture — `bash -c grep vitest something` — was reported as a run, which
  // would stand the sweep down for as long as somebody greps for the word. These are
  // observers, never runners.
  const OBSERVER = /\b(grep|rg|ag|ps|pgrep|pkill|awk|sed|find|xargs|tail|less)\b/;
  return rows
    .filter((r) => /\bvitest\b/.test(r.cmd) && !OBSERVER.test(r.cmd))
    .filter((r) => !isOurs(r.pid))
    .map((r) => r.pid);
}

/**
 * Is another vitest alive on this machine?
 *
 * ⚠ FAILS CLOSED, unlike everything else here: when `ps` cannot be read we answer YES
 * and the sweep stands down. Every other failure in this file costs disk; this one
 * would cost somebody's run.
 */
export function otherVitestRunning(
  selfPid: number = process.pid,
  readPs: () => string = () => execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8' }),
): boolean {
  try {
    return foreignVitestPids(readPs(), selfPid).length > 0;
  } catch {
    return true;
  }
}

/**
 * Remove every stale cache under `root`. Returns the paths it removed.
 *
 * ⚠ FAIL-OPEN BY DESIGN, per entry and overall. This is hygiene, not a gate: a
 * directory that vanishes under us mid-scan, or one we may not read, must never
 * fail somebody's test run. The one thing it does loudly is SAY what it removed.
 */
export function sweepStaleVitestTmp(
  root: string = tmpdir(),
  now: number = Date.now(),
  staleMs: number = STALE_MS,
  log: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
  othersRunning: () => boolean = otherVitestRunning,
): string[] {
  const removed: string[] = [];
  // ⛔ A live run's cache can look stale (see the header). While another vitest is up,
  // this does nothing — and says so, because a sweep that silently skips is
  // indistinguishable from one that found nothing.
  if (othersRunning()) {
    log('vitest-tmp-cleanup: another vitest is running — skipping the sweep');
    return removed;
  }
  // `now` is compared against file mtimes; `NaN` makes every comparison false and would
  // delete a FRESH directory. Production passes `Date.now()`, so this guards the API.
  if (!Number.isFinite(now)) return removed;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of names) {
    const p = join(root, name);
    try {
      if (!isVitestTmpCache(root, name)) continue;
      const newest = newestFileMtime(p);
      if (newest === null) continue;
      const ageMs = now - newest;
      if (ageMs < staleMs) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(p);
      log(`vitest-tmp-cleanup: removed ${p} (newest file ${Math.round(ageMs / 60000)} min old)`);
    } catch {
      // Unreadable, or gone between the check and the removal. Both are fine.
    }
  }
  return removed;
}
