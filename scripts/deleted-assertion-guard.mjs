#!/usr/bin/env node
/**
 * deleted-assertion-guard.mjs — a restructuring that DELETES a working assertion looks exactly like
 * one that replaces it, and nothing in the build can tell the difference.
 *
 *   node scripts/deleted-assertion-guard.mjs <base-sha> <head-sha>
 *
 * Exit 0 = nothing to report, or every deletion was FORCED · 1 = at least one deletion was
 * UNNECESSARY, proven · 2 = could not check, and that does NOT block.
 *
 * ⭐ WHAT IT MEASURES, and why it is a measurement and not a style rule. For every test file the
 * diff removes lines from, it takes that file **as it stood at the base commit** and runs it
 * against the **new** source.
 *
 *   · the old test passes  ⇒ the assertion it carried still holds, so deleting it removed cover
 *                            for nothing. That is a FINDING, not a preference.
 *   · the old test fails    ⇒ the deletion was forced by the change, and the reason belongs in the
 *                            commit message. Reported, never blocked.
 *
 * ⛔ FAIL DIRECTION — OPEN, on purpose, and this is the half that gets built backwards. The old
 * file is run against source it was not written for. A legitimate signature change makes it fail to
 * compile, and a compile failure is indistinguishable here from a real regression. So ONLY A GREEN
 * RUN BLOCKS: green is positive proof that the deletion cost cover, and nothing else is proof of
 * anything. Built the other way round, this guard would stop every honest rename and be switched
 * off inside two weeks — which is worse than not having it, because a disabled guard still reads as
 * coverage on the board.
 *
 * ⭐ WHY THIS EXISTS AT ALL. The rule is already written down — *replacing is a suspicion,
 * extending is the default* — and prose lost to the normal case: a session restructured a guard,
 * removed three assertions, and typecheck, lint and the whole suite stayed green while **two
 * attacks were open again**. The old test file, run against the new source, scored 125/125 and
 * killed both. "Unnecessary" was therefore measured, not argued — which is the only reason this
 * guard can be built from a second test run instead of a parser.
 *
 * ⚠ WHAT IT DOES NOT SEE. Assertions that do not live in a test file (a `satisfies` weld, a type
 * constraint, a guard clause in `src/`) are invisible to it. It is a floor for one shape of loss,
 * not a classifier for loss in general.
 *
 * ⚠ A MOVE IS NOT A DELETION, and getting this wrong is expensive rather than theoretical: an
 * "added/removed lines" check fired 101, 108 and 264 false findings on a single pull request that
 * only moved files. Two defences, both structural rather than per-directory exceptions:
 *   1. renames are resolved by git itself (`-M`), so a renamed test file never becomes a candidate;
 *   2. a removed line that reappears byte-identically among the diff's ADDED lines is a move, and a
 *      file whose every removed line reappears is skipped entirely.
 *
 * ⛔ IT REFUSES TO RUN ON A DIRTY TREE. It writes an old file into the working tree to run it. In
 * CI that tree is disposable; on a developer's machine it is not, and a mutation in a live tree has
 * real side effects — so an uncommitted change anywhere is exit 2, not a cleanup attempt.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TEST_GLOBS = ['*.test.ts', '*.spec.ts', '*.test.tsx', '*.spec.tsx'];

/** Run a command and return stdout; throws on a non-zero exit. */
function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 1 << 28, ...opts });
}

/** stdout of a command that is allowed to fail; returns `{ ok, out }`. */
function tryRun(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf-8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * Test files this diff removes lines from.
 *
 * ⚠ The filter is `MD`, not `ACMR`. `ACMR` omits deleted files, and a test file deleted WHOLE is
 * the main case this guard is for — the one that would silently never be a candidate.
 * `-M` is what keeps a rename out: git reports it as `R`, which neither letter selects.
 */
export function candidateFiles(base, head) {
  const out = git(['diff', '-M', '--diff-filter=MD', '--numstat', `${base}..${head}`, '--', ...TEST_GLOBS]);
  const files = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const deletions = m[2] === '-' ? 0 : Number(m[2]);
    if (deletions > 0) files.push(m[3]);
  }
  return files;
}

/**
 * Every line this diff REMOVED and every line it ADDED, as trimmed multisets.
 * Used only to recognise a move; never to judge a file on its own.
 */
export function movedLineSets(base, head) {
  const out = git(['diff', '-M', `${base}..${head}`]);
  const removed = [];
  const added = [];
  for (const line of out.split('\n')) {
    if (/^(---|\+\+\+)/.test(line)) continue;
    if (line.startsWith('-')) removed.push(line.slice(1).trim());
    else if (line.startsWith('+')) added.push(line.slice(1).trim());
  }
  return { removed, added: new Set(added.filter((l) => l.length > 0)) };
}

/** True when every non-empty line this file lost reappears byte-identically among the added lines. */
export function isPureMove(base, head, file, addedSet) {
  const out = git(['diff', '-M', `${base}..${head}`, '--', file]);
  const lost = [];
  for (const line of out.split('\n')) {
    if (/^(---|\+\+\+)/.test(line)) continue;
    if (line.startsWith('-')) {
      const t = line.slice(1).trim();
      if (t.length > 0) lost.push(t);
    }
  }
  if (lost.length === 0) return false;
  return lost.every((l) => addedSet.has(l));
}

/**
 * The whole check, with the test RUNNER passed in.
 *
 * ⚠ The runner is a parameter and not an environment variable on purpose. An env switch would be a
 * bypass — someone could point it at `true` and the guard would report every deletion as
 * unnecessary… or at `false` and it would report none. As a parameter, the shipped path has exactly
 * one runner (`main` below) and the test supplies its own, so there is nothing to set at runtime.
 *
 * @param {{base: string, head: string, runner: (file: string) => {ok: boolean, out: string},
 *          log?: (s: string) => void}} opts
 */
export function check({ base, head, runner, log = console.log }) {
  // ⚠ TRACKED changes only, and the narrowing is a correction found by running this for real.
  // The first version refused on ANY porcelain output — including untracked files — and an
  // untracked editor leftover was enough to make the guard exit 2. Exit 2 does not block, so the
  // guard would simply never run while still reading as coverage on the board: the exact failure
  // this file's header warns about for the opposite polarity.
  //   · a modified or staged TRACKED file ⇒ refuse. Two reasons, and the second is the sharper
  //     one: the file could be a candidate we would overwrite, and any tracked modification means
  //     the run no longer measures the HEAD source, so a green verdict would be about something
  //     else.
  //   · an UNTRACKED file ⇒ name it and proceed. It is not part of HEAD, and it cannot be
  //     clobbered by a restore that only ever writes back what it read.
  const dirty = tryRun('git', ['status', '--porcelain']);
  if (!dirty.ok) return { status: 2, reason: 'tree-unreadable', findings: [], forced: [], unreadable: [], moves: [] };
  const lines = dirty.out.split('\n').filter((l) => l.trim().length > 0);
  const trackedDirty = lines.filter((l) => !l.startsWith('??'));
  const untracked = lines.filter((l) => l.startsWith('??')).map((l) => l.slice(3));
  if (trackedDirty.length > 0) {
    return { status: 2, reason: 'tree-dirty', findings: [], forced: [], unreadable: [], moves: [], trackedDirty };
  }
  for (const u of untracked) log(`  note  untracked, ignored: ${u}`);

  let candidates;
  try {
    candidates = candidateFiles(base, head);
  } catch {
    return { status: 2, reason: 'diff-unreadable', findings: [], forced: [], unreadable: [], moves: [] };
  }
  if (candidates.length === 0) return { status: 0, reason: 'no-candidates', findings: [], forced: [], unreadable: [], moves: [], candidates };

  const { added } = movedLineSets(base, head);
  const findings = [];
  const forced = [];
  const unreadable = [];
  const moves = [];

  for (const file of candidates) {
    if (isPureMove(base, head, file, added)) {
      moves.push(file);
      log(`  move  ${file} — every removed line reappears byte-identically; not a deletion`);
      continue;
    }
    let oldSource;
    try {
      oldSource = git(['show', `${base}:${file}`]);
    } catch {
      unreadable.push([file, 'the base commit has no such file']);
      continue;
    }
    const existedAtHead = existsSync(file);
    const backup = existedAtHead ? readFileSync(file, 'utf-8') : null;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, oldSource, 'utf-8');
      const run = runner(file);
      if (run.ok) findings.push(file);
      else forced.push([file, lastMeaningfulLine(run.out)]);
    } finally {
      if (backup === null) rmSync(file, { force: true });
      else writeFileSync(file, backup, 'utf-8');
    }
  }
  return { status: findings.length > 0 ? 1 : 0, reason: 'checked', findings, forced, unreadable, moves, candidates };
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error('deleted-assertion-guard: usage: node scripts/deleted-assertion-guard.mjs <base-sha> <head-sha>');
    process.exit(2);
  }
  const runner = (file) => tryRun('npx', ['vitest', 'run', file, '--reporter', 'dot'], { env: { ...process.env, CI: '1' } });
  const r = check({ base, head, runner });

  if (r.status === 2) {
    const why = {
      'tree-unreadable': 'could not read the working tree state',
      'tree-dirty': 'the working tree has uncommitted changes. This guard writes a file into the tree to run it,\n  so it refuses rather than touch your work. Commit or stash, then re-run.',
      'diff-unreadable': 'could not read the diff',
    }[r.reason] ?? r.reason;
    console.log(`deleted-assertion-guard: ${why} — NOT blocking (exit 2)`);
    process.exit(2);
  }
  if (r.reason === 'no-candidates') {
    console.log('deleted-assertion-guard: clean ✓ (this diff removes no lines from any test file)');
    process.exit(0);
  }
  for (const [file, why] of r.unreadable) console.log(`  skip  ${file} — ${why}`);
  for (const [file, why] of r.forced) {
    console.log(`  forced  ${file}`);
    console.log(`          the base version does not pass against the new source: ${why}`);
    console.log('          → the deletion was forced. Say so in the commit message; nothing is blocked.');
  }
  if (r.status === 0) {
    console.log(`deleted-assertion-guard: clean ✓ (${r.candidates.length} candidate(s); no deletion was unnecessary)`);
    process.exit(0);
  }
  console.log('');
  for (const file of r.findings) {
    console.log(`::error::deleted-assertion-guard: ${file} — the version at ${base.slice(0, 8)} PASSES against the new source.`);
  }
  console.log('');
  console.log('  The assertions this diff removed still hold. Deleting them removed cover for nothing.');
  console.log('  Restore them, or say in the commit message what the new code asserts instead and where.');
  console.log('  This is the one case the guard blocks on, because a green run is positive proof.');
  process.exit(1);
}

/**
 * The line of a failing run that tells a human WHY.
 *
 * ⚠ The first version took the last non-empty line, and a real run reported `⎯⎯⎯[4/4]⎯` — a
 * progress separator. Since the whole purpose of the `forced` branch is that somebody reads the
 * reason, a separator there makes the branch useless while looking like it works. So: prefer a line
 * that carries an error marker, and never return one that is only box-drawing or punctuation.
 */
export function lastMeaningfulLine(out) {
  const lines = out
    .split('\n')
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((l) => l.length > 0)
    // Drop progress bars, rules and timing furniture: anything with no letters and no digits.
    .filter((l) => /[A-Za-z0-9]/.test(l.replace(/[\u2500-\u257f\u23af\u2014\u2013]/g, '')))
    .filter((l) => !/^(Duration|Start at|RUN|Test Files|Tests)\b/.test(l));
  const marked = lines.find((l) =>
    /\b(error|Error|FAIL|failed|Cannot|cannot|is not|undefined|TS\d{4})\b/.test(l),
  );
  const pick = marked ?? lines[lines.length - 1];
  return pick ? pick.slice(0, 160) : '(the run produced no readable output)';
}

if (process.argv[1] && process.argv[1].endsWith('deleted-assertion-guard.mjs')) main();
