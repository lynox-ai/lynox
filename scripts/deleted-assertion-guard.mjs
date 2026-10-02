#!/usr/bin/env node
/**
 * deleted-assertion-guard.mjs — did this pull request remove test CASES that still hold?
 *
 *   node scripts/deleted-assertion-guard.mjs <base-ref> <head-ref>
 *
 * Exit 0 = checked, nothing to report · 1 = something to report (ADVISORY) · 2 = could not check.
 *
 * ⛔ IT IS A REPORTER, NOT A GATE, and the polarity is the opposite of the obvious one: **the
 * workflow fails only on exit 2.** A finding costs a reader one minute; a false alarm costs nothing;
 * and the blind spot below breaks nothing, because nothing is allowed to rest on this. What IS gated
 * is the instrument's HEALTH — a check that silently stops looking still reads as coverage.
 *
 * ⭐ WHAT IT MEASURES, and the measuring device is the RUNNER, never a regular expression.
 * For every file the diff removes lines from, and that vitest itself says it would run:
 *   1. count the test cases the BASE version declares  (run it, read `Tests … (N)`)
 *   2. count the test cases the HEAD version declares  (0 if the file is gone)
 *   3. report only when the count DROPPED **and** the base version passes against the new source.
 *
 * ⛔ WHY THE COUNT AND NOT "REMOVED LINES" — this is the premise the first version got wrong, and it
 * was wrong in the direction that gets a guard switched off. "Removed test lines" is a PROXY for
 * "removed coverage", and a bad one: a retitled `it()`, a renamed variable, `toBe` rewritten as
 * `toStrictEqual`, a prettier re-wrap, an assertion extracted into a helper — each removes lines and
 * removes no coverage. The base file then passes, and a green run there is **not a finding: it is
 * the proof that nothing is missing**, because it tests the same thing. Measured in a throwaway
 * repository: a change that only retitled two tests was reported as a finding. A guard that blocks
 * every rename is switched off in days.
 *
 * ⚠ ITS BLIND SPOT, stated here AND in its own output, because a report must say what it KNOWS:
 * deleting two cases while adding three keeps the count up and does not appear. Closing that needs
 * the property instead of the proxy — coverage instrumentation — which is a different and much
 * larger instrument. The limit is named, not papered over.
 *
 * ⚠ WHAT IT DOES NOT SEE AT ALL: assertions outside a test file (a `satisfies` weld, a type
 * constraint, a guard clause in `src/`), and a test file renamed AND edited in the same commit — git
 * reports that as `R`, which `--diff-filter=MD` does not select, so the edit inside the rename is
 * invisible. A floor for one shape of loss, not a classifier for loss.
 *
 * ⚠ A MOVE IS NOT A DELETION, with MULTIPLICITY. An "added/removed lines" check once fired 101, 108
 * and 264 false findings on a pull request that only moved files. Three defences: renames are
 * resolved by git (`-M`), so a renamed file is never a candidate; a lost line counts as moved only
 * if an added line is still AVAILABLE to match it (a multiset, so one added `});` cannot absolve
 * five lost ones); and the comparison spans the whole diff, because a move to another file is a move.
 *
 * ⛔ IT REFUSES ON A TRACKED MODIFICATION. It writes a file into the tree to run it. A tracked change
 * means the run would not measure HEAD anyway, and it could be work to clobber. An UNTRACKED file is
 * named and ignored — refusing on those made an earlier version exit 2 on an editor leftover, and
 * since exit 2 reports no finding, the guard would have been permanently silent while still counting
 * as a check.
 *
 * ⛔ EVERY FAILURE IS EXIT 2. An earlier version let a thrown git error reach node's default exit of
 * 1, which the workflow read as "a deleted assertion still holds" — announcing a finding nobody had
 * measured. There is now one try/catch around the whole run and no path to 1 except a real report.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Run a command; throws on a non-zero exit. */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 1 << 28 });
}

/** Run a command that is allowed to fail. */
function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf-8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/**
 * The point the two refs diverge.
 *
 * ⛔ `merge-base`, not `base..head`. A two-dot diff also carries everything the base branch moved
 * since the fork, so a test file this pull request never touched shows removed lines and becomes a
 * candidate. An earlier version's own comment named this problem and then used the two-dot form.
 */
export function mergeBase(base, head) {
  return git(['merge-base', base, head]).trim();
}

/** Files the diff removes lines from. `MD`, because `ACMR` omits the wholly deleted file — the main case. */
export function removedFrom(base, head) {
  const out = git(['diff', '-M', '--diff-filter=MD', '--numstat', `${base}...${head}`]);
  const files = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[2] !== '-' && Number(m[2]) > 0) files.push(m[3]);
  }
  return files;
}

/** A MULTISET of every line the diff adds: line → how many times it was added. */
export function addedMultiset(base, head) {
  const counts = new Map();
  for (const line of git(['diff', '-M', `${base}...${head}`]).split('\n')) {
    if (line.startsWith('+++')) continue;
    if (!line.startsWith('+')) continue;
    const t = line.slice(1).trim();
    if (t.length === 0) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * True when every non-empty line this file lost can be matched by a STILL-AVAILABLE added line.
 * Consumes from the multiset, so one added `});` cannot absolve five lost ones.
 */
export function isPureMove(base, head, file, addedCounts) {
  const lost = [];
  for (const line of git(['diff', '-M', `${base}...${head}`, '--', file]).split('\n')) {
    if (line.startsWith('---')) continue;
    if (!line.startsWith('-')) continue;
    const t = line.slice(1).trim();
    if (t.length > 0) lost.push(t);
  }
  if (lost.length === 0) return false;
  const budget = new Map(addedCounts);
  for (const l of lost) {
    const left = budget.get(l) ?? 0;
    if (left === 0) return false;
    budget.set(l, left - 1);
  }
  return true;
}

/**
 * How many test cases a run declared, or null when the run collected none.
 *
 * ⚠ Read from the runner's own summary line, not counted from the source: `it.each`, `test`,
 * `describe.each` and a commented-out block all defeat a textual count, and the runner does not.
 */
export function caseCount(out) {
  const m = /^\s*Tests\s+.*?\((\d+)\)\s*$/m.exec(out);
  if (m) return Number(m[1]);
  if (/No test files found/.test(out)) return 0;
  return null;
}

/**
 * The whole check, with the runner passed in.
 *
 * ⚠ The runner is a parameter and not an environment variable. An env switch would be a bypass:
 * point it at `true` and every deletion reads as a finding, at `false` and none does. As a parameter
 * the shipped path has exactly one runner and the test supplies its own.
 *
 * @param {{base: string, head: string,
 *          runFile: (f: string) => {ok: boolean, out: string},
 *          listFiles: () => string[],
 *          log?: (s: string) => void}} opts
 */
export function check({ base, head, runFile, listFiles, log = () => {} }) {
  const dirty = tryRun('git', ['status', '--porcelain']);
  if (!dirty.ok) return { status: 2, reason: 'tree-unreadable' };
  const lines = dirty.out.split('\n').filter((l) => l.trim().length > 0);
  const trackedDirty = lines.filter((l) => !l.startsWith('??'));
  if (trackedDirty.length > 0) return { status: 2, reason: 'tree-dirty', trackedDirty };
  for (const u of lines.filter((l) => l.startsWith('??'))) log(`  note      untracked, ignored: ${u.slice(3)}`);

  const mb = mergeBase(base, head);
  const candidates = removedFrom(mb, head);
  if (candidates.length === 0) return { status: 0, reason: 'no-candidates', findings: [], skipped: [], moves: [], candidates: [] };

  const addedCounts = addedMultiset(mb, head);
  const findings = [];
  const skipped = [];
  const moves = [];

  for (const file of candidates) {
    if (isPureMove(mb, head, file, addedCounts)) {
      moves.push(file);
      log(`  move      ${file} — every lost line is matched by an added one`);
      continue;
    }

    let baseSource;
    try {
      baseSource = git(['show', `${mb}:${file}`]);
    } catch {
      skipped.push([file, 'the merge base has no such file']);
      continue;
    }

    // The HEAD count comes first, while the tree is still untouched. A file that is gone declares none.
    let headCount = 0;
    const existedAtHead = existsSync(file);
    if (existedAtHead) {
      if (!listFiles().includes(file)) {
        skipped.push([file, 'the runner does not run this file (it is not in the runner\'s own file list)']);
        continue;
      }
      const headRun = runFile(file);
      const hc = caseCount(headRun.out);
      if (hc === null) {
        skipped.push([file, `the head version collected no cases, so there is no count to compare: ${reasonLine(headRun.out)}`]);
        continue;
      }
      headCount = hc;
    }

    const backup = existedAtHead ? readFileSync(file, 'utf-8') : null;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, baseSource, 'utf-8');
      // Asked here for a wholly deleted file: it cannot be in the runner's list before it is written back.
      if (!listFiles().includes(file)) {
        skipped.push([file, 'the runner does not run this file (it is not in the runner\'s own file list)']);
        continue;
      }
      const baseRun = runFile(file);
      // ⚠ ORDER MATTERS, and a test found it. A base version that fails to compile ALSO has no
      // parseable count, so checking the count first swallowed the more specific and more useful
      // diagnosis — "the removal was forced" — and reported "collected no cases" instead. The
      // failing run is the sharper fact, so it is read first.
      if (!baseRun.ok) {
        skipped.push([file, `the base version fails against the new source — the removal was forced: ${reasonLine(baseRun.out)}`]);
        continue;
      }
      const baseCount = caseCount(baseRun.out);
      if (baseCount === null) {
        skipped.push([file, `the base version ran but declared no readable case count: ${reasonLine(baseRun.out)}`]);
        continue;
      }
      if (baseCount > headCount) findings.push({ file, baseCount, headCount });
      else log(`  same      ${file} — ${String(baseCount)} case(s) before, ${String(headCount)} after; the count did not drop`);
    } finally {
      if (backup === null) rmSync(file, { force: true });
      else writeFileSync(file, backup, 'utf-8');
    }
  }
  return { status: findings.length > 0 ? 1 : 0, reason: 'checked', findings, skipped, moves, candidates };
}

/**
 * The line of a run that tells a human WHY.
 *
 * ⚠ Measured: taking the last non-empty line reported `⎯⎯⎯[4/4]⎯`, a progress separator. Where the
 * output IS the purpose, the output is what has to be tested.
 */
export function reasonLine(out) {
  const lines = out
    .split('\n')
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((l) => l.length > 0)
    .filter((l) => /[A-Za-z0-9]/.test(l.replace(/[─-╿⎯—–]/g, '')))
    .filter((l) => !/^(Duration|Start at|RUN|Test Files|Tests)\b/.test(l));
  const marked = lines.find((l) => /\b(error|Error|FAIL|failed|Cannot|cannot|is not|undefined|TS\d{4})\b/.test(l));
  const pick = marked ?? lines[lines.length - 1];
  return pick ? pick.slice(0, 150) : '(the run produced no readable output)';
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.log('deleted-assertion-guard: usage: node scripts/deleted-assertion-guard.mjs <base-ref> <head-ref>');
    process.exit(2);
  }
  let r;
  try {
    const env = { ...process.env, CI: '1' };
    r = check({
      base,
      head,
      runFile: (f) => tryRun('npx', ['vitest', 'run', f, '--reporter', 'dot'], { env }),
      // ⚠ The runner names its own file set. An earlier version used a glob, which pulled in eight
      // Playwright specs vitest cannot run — they read as "forced" forever, so the guard did not
      // exist for an eighth of its own set. Also: vitest's path argument is a SUBSTRING filter, so
      // membership is asserted here rather than inferred from the argument being accepted.
      listFiles: () => {
        const l = tryRun('npx', ['vitest', 'list', '--filesOnly'], { env });
        return l.ok ? l.out.split('\n').map((s) => s.trim()).filter((s) => /\.(test|spec)\.tsx?$/.test(s)) : [];
      },
      log: console.log,
    });
  } catch (e) {
    // ⛔ ONE catch for everything, and it is exit 2.
    console.log(`deleted-assertion-guard: could not check — ${String(e).split('\n')[0].slice(0, 160)}`);
    process.exit(2);
  }

  if (r.status === 2) {
    const why = {
      'tree-unreadable': 'could not read the working tree state',
      'tree-dirty': 'the working tree has tracked changes; this guard writes a file into the tree to run it, so it refuses rather than touch your work',
    }[r.reason] ?? r.reason;
    console.log(`deleted-assertion-guard: ${why}`);
    if (r.trackedDirty) for (const l of r.trackedDirty.slice(0, 10)) console.log(`    ${l}`);
    process.exit(2);
  }
  if (r.reason === 'no-candidates') {
    console.log('deleted-assertion-guard: nothing to look at (this diff removes no lines from any tracked file)');
    process.exit(0);
  }
  for (const [file, why] of r.skipped) console.log(`  skip      ${file} — ${why}`);
  if (r.findings.length === 0) {
    console.log(`deleted-assertion-guard: nothing to report (${String(r.candidates.length)} candidate(s) examined)`);
    process.exit(0);
  }
  console.log('');
  for (const { file, baseCount, headCount } of r.findings) {
    console.log(`  REPORT  ${file}: ${String(baseCount)} test case(s) before, ${String(headCount)} after — and all ${String(baseCount)} still pass against the new source.`);
  }
  console.log('');
  console.log('  What this knows: that many cases are gone, and the ones that were there still hold.');
  console.log('  What it does NOT know, and cannot: whether something else now covers them. It compares');
  console.log('  only the NUMBER of cases per file — deleting two while adding three keeps the number up');
  console.log('  and does not appear here at all.');
  console.log('  Nothing is blocked. If the removal was deliberate, the commit message is where to say so.');
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('deleted-assertion-guard.mjs')) main();
