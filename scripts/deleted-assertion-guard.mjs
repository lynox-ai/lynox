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
 * ⭐ WHAT IT MEASURES. For every file the diff removes lines from:
 *   1. how many cases the HEAD version actually RUNS            (0 if the file is gone)
 *   2. how many cases the BASE version PASSES against the new source
 *   3. report when (2) exceeds (1) — cases that held and no longer run.
 *
 * ⭐⭐ THE NUMBERS COME FROM THE RUNNER'S JSON, NOT FROM ITS PROSE, and this is the second premise
 * this file got wrong. The first version read `Tests … (N)` out of the human-readable summary, and a
 * refutation round measured that **the guard was dead in the only environment it runs in**: vitest
 * colours that line whenever `CI` is in the environment (tinyrainbow never consults `isTTY`), so the
 * line arrives as `ESC[2m      Tests ESC[22m …` and `^\s*Tests` cannot match — ESC is not `\s`.
 * Every candidate was then skipped as "collected no cases", `findings` stayed empty, and the job
 * printed "nothing to report" and passed green. It looked correct locally for one reason only: this
 * harness sets `CLAUDECODE`, vitest's `isAgent` is then true and it disables colour. **The
 * instrument had been validated where it works instead of where it runs.** Three more defects died
 * with that one: `Tests  no tests` parsed as "no count" instead of zero, so a file emptied of ALL
 * its cases — the loudest form of the thing this looks for — was skipped; `it.skip`/`it.todo` count
 * toward the parenthesised total, so converting four cases to `it.skip` left the number unchanged;
 * and because the summary is read from the same stream the SUBJECT writes to, one
 * `console.log('      Tests  99 passed (99)')` inside a test set the head count to 99 and suppressed
 * every finding in the file. The JSON reporter answers per FILE, per CASE, with states, into a file
 * the subject cannot write to. Prose is an interface for humans; a number taken from it is a proxy.
 *
 * ⛔ WHY CASES AND NOT "REMOVED LINES" — the first premise this file got wrong, and it was wrong in
 * the direction that gets a guard switched off. "Removed test lines" is a PROXY for "removed
 * coverage", and a bad one: a retitled `it()`, a renamed variable, `toBe` rewritten as
 * `toStrictEqual`, a prettier re-wrap — each removes lines and removes no coverage. Measured on a
 * real file: a change that only retitled three tests was reported as a finding. A guard that blocks
 * every rename is switched off in days.
 *
 * ⭐ AND "PASSED", NOT "DECLARED", IS WHAT MAKES THE FORCED CASE DISAPPEAR. A base version that
 * cannot compile against the new source passes nothing, so it can never produce a finding — no
 * special case, and no "was the removal forced?" branch whose order there is to get wrong. The
 * sentence this guard reports is now literally the sentence it computes.
 *
 * ⚠ ITS BLIND SPOT, stated here AND in its own output, because a report must say what it KNOWS:
 * deleting two cases while adding three keeps the number up and does not appear. Closing that needs
 * the property instead of the proxy — coverage instrumentation — which is a different and much
 * larger instrument. Deliberately out of scope, not pending.
 *
 * ⚠ WHAT IT DOES NOT SEE AT ALL: assertions outside a test file (a `satisfies` weld, a type
 * constraint, a guard clause in `src/`); and two rename shapes, because `-M` does not make renames
 * safe, it moves the problem across a SIMILARITY THRESHOLD and the behaviour flips at it. Above
 * git's default 50% the pair is `R`, which `--diff-filter=MD` does not select, so a rename that also
 * deletes cases is invisible — and so is a test file renamed OUT of the runner's include globs,
 * which is `R100` and loses 100% of its coverage silently. Below the threshold it is plain `D`+`A`,
 * so the old path IS examined and is reported with 0 cases running, which is true of that path and
 * says nothing about where the cases went. Reading `MDR` and resolving the pair would close the
 * first two; that is registered, not half-built here.
 *
 * ⚠ A MOVE IS NOT A DELETION, with MULTIPLICITY and ONE BUDGET. An "added/removed lines" check once
 * fired 101, 108 and 264 false findings on a pull request that only moved files. Three defences:
 * renames are resolved by git (`-M`) above the threshold above; a lost line counts as moved only if
 * an added line is still AVAILABLE to match it; and the budget is **threaded through the whole
 * candidate loop**, because a copy of the map per candidate let ONE added line absolve the same lost
 * line in five different files — the exact claim the earlier comment here made and did not keep.
 * Added lines count only where they land in a file the runner RUNS: text pasted into a markdown file
 * is not a move, it is a deletion with a souvenir.
 *
 * ⛔ IT REFUSES ON A TRACKED MODIFICATION. It writes a file into the tree to run it. A tracked change
 * means the run would not measure HEAD anyway, and it could be work to clobber. An UNTRACKED file is
 * named and ignored — refusing on those made an earlier version exit 2 on an editor leftover, and
 * since exit 2 reports no finding, the guard would have been permanently silent while still counting
 * as a check. It also refuses when the checked-out commit is not the `head` it was given: the head
 * side reads the WORKING TREE while the diff side reads the ref, and with the two out of step the
 * guard compared head against head and reported nothing, confidently.
 *
 * ⛔ EVERY FAILURE IS EXIT 2 — and the workflow does not believe an exit code without the VERDICT
 * line below it. An earlier version let a thrown git error reach node's default exit of 1, which the
 * workflow read as "a deleted assertion still holds". node also exits 1 for a module-load failure,
 * which no try/catch inside this file can ever catch, so the exit code alone cannot tell a verdict
 * from a crash.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, mkdtempSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf-8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], ...opts }) };
  } catch (e) {
    return { ok: false, out: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}` || String(e) };
  }
}

/**
 * ⛔ `merge-base`, not `base..head`. A two-dot diff also carries everything the base branch moved
 * since the fork, so a case deleted on main by someone else reads as deleted by this pull request.
 */
export function mergeBase(base, head) {
  return git(['merge-base', base, head]).trim();
}

/** Parse `--numstat -z` records into `{added, deleted, path}`, taking the LAST path of a rename pair. */
function numstatZ(out) {
  const rows = [];
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(fields[i]);
    if (!m) continue;
    let path = m[3];
    if (path.length === 0) {
      // A rename record puts the paths in the following fields: old, then new.
      const a = fields[(i += 1)];
      const b = fields[i + 1];
      if (b !== undefined && b !== '' && !/^(\d+|-)\t/.test(b)) { path = b; i += 1; } else path = a ?? '';
    }
    if (!path) continue;
    rows.push({ added: m[1], deleted: m[2], path });
  }
  return rows;
}

/**
 * Files the diff removes lines from. `MD`, because `ACMR` omits the wholly deleted file — the main case.
 *
 * ⛔ `-z`, and it is not cosmetic. Under the default `core.quotePath=true`, `--numstat` C-quotes any
 * path holding a non-ASCII byte: `"src/gr\303\274\303\237.test.ts"`. The quotes and octal escapes
 * would be captured into the path, `git show <base>:<that>` would throw, and the file would be
 * skipped as "the merge base has no such file" — a diagnosis that is FALSE, since the file is there.
 * No tracked path here is non-ASCII today, so the bug was invisible and the skip would have read as
 * a legitimate one. `-z` emits raw paths in NUL-separated records.
 */
export function removedFrom(base, head) {
  return numstatZ(git(['diff', '-M', '-z', '--diff-filter=MD', '--numstat', `${base}...${head}`]))
    .filter((r) => r.deleted !== '-' && Number(r.deleted) > 0)
    .map((r) => r.path);
}

/** Every file the diff ADDS lines to — the possible destinations of a move. */
export function addedTo(base, head) {
  return numstatZ(git(['diff', '-M', '-z', '--diff-filter=ACMR', '--numstat', `${base}...${head}`]))
    .filter((r) => r.added !== '-' && Number(r.added) > 0)
    .map((r) => r.path);
}

/**
 * The non-empty content lines a diff adds (`sign` `'+'`) or removes (`'-'`), trimmed.
 *
 * ⛔ STRUCTURAL, not by prefix, and a reproduction is why. Judging a header by `startsWith('---')`
 * or `'+++'` also swallows CONTENT: a removed line whose text begins `--` renders as `---…`, an
 * added line beginning `++` as `+++…`. Both occur in real `.test.ts` files — a CSS custom property
 * or an SQL comment inside a template literal, `--i;`, a `--flag` string. Measured on such a diff,
 * the prefix reading lost 2 of 3 removed lines and the only added one. Both directions are defects:
 * an invisible lost line lets the move budget be satisfied by fewer lines than were really lost, so
 * a real deletion is never examined; a missing added line makes a genuine move unabsolvable, so a
 * finding is reported on a pure move — the 101/108/264 class this very detection exists to prevent.
 *
 * Header lines live BEFORE the first `@@` of each file, so the state machine resets on `diff --git`.
 * A content line can never be mistaken for one: it always carries a `+`, `-` or space prefix, so a
 * bare `diff --git ` or `@@` at column zero is always a header.
 */
export function diffContentLines(args, sign) {
  const res = [];
  let inHunk = false;
  for (const line of git(args).split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line[0] !== sign) continue;
    const t = line.slice(1).trim();
    if (t.length > 0) res.push(t);
  }
  return res;
}

/**
 * A MULTISET of every line the diff adds INTO A FILE THE RUNNER RUNS: line → how many times.
 *
 * ⚠ `runs` is the filter and it is load-bearing. Built from the whole diff, the multiset absolved a
 * test file whose entire text had been pasted into an added markdown file as a fenced block — logged
 * as "every lost line is matched by an added one" while three cases were gone. A line that lands
 * where the runner never looks has not moved.
 */
export function addedMultiset(base, head, runs) {
  const counts = new Map();
  for (const dest of addedTo(base, head)) {
    if (!runs(dest)) continue;
    for (const t of diffContentLines(['diff', '-M', `${base}...${head}`, '--', dest], '+')) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * True when every non-empty line this file lost can be matched by a STILL-AVAILABLE added line,
 * CONSUMING from the shared `budget`.
 *
 * ⚠ The budget belongs to the whole run, not to one file. With a copy per candidate, five files each
 * losing `it("holds", () => {});` were all absolved by the ONE copy the diff added — four cases
 * gone, nothing reported, while the comment above claimed a multiset prevented exactly that. The
 * consequence of sharing it is that the ORDER of candidates decides who gets the match; git's order
 * is used, and that is a deliberate arbitrary choice rather than an accident, because the
 * alternative is pretending one line moved five times. A file that turns out NOT to be a move puts
 * back what it took, so it cannot starve the next one.
 */
export function isPureMove(base, head, file, budget) {
  const lost = diffContentLines(['diff', '-M', `${base}...${head}`, '--', file], '-');
  if (lost.length === 0) return false;
  const taken = [];
  for (const l of lost) {
    const left = budget.get(l) ?? 0;
    if (left === 0) {
      for (const k of taken) budget.set(k, (budget.get(k) ?? 0) + 1);
      return false;
    }
    budget.set(l, left - 1);
    taken.push(l);
  }
  return true;
}

/**
 * What the runner did with ONE file, from its JSON: how many cases RAN, how many PASSED.
 * `null` when the run produced no result for this file at all.
 *
 * ⭐ `passed`/`failed` only. `skipped` and `todo` appear in the runner's own total, so counting the
 * total let a pull request convert four cases to `it.skip` with the number unchanged — all four
 * stopped running and nothing was reported. A case that does not run is not coverage.
 *
 * ⭐ And the entry is selected BY PATH, which is what makes the runner's substring path filter
 * harmless: `vitest run src/a.test.ts` may also run `pkg/src/a.test.ts`, and a total would be the
 * sum over both. Reading the named file's own entry needs no precondition about file names at all —
 * an earlier version measured and documented one instead, which was a weaker answer to the same
 * question.
 */
export function casesFor(json, file) {
  const abs = resolve(file);
  const entry = (json?.testResults ?? []).find((r) => resolve(String(r.name)) === abs);
  if (!entry) return null;
  const states = (entry.assertionResults ?? []).map((a) => String(a.status));
  return {
    ran: states.filter((s) => s === 'passed' || s === 'failed').length,
    passed: states.filter((s) => s === 'passed').length,
  };
}

const TEST_FILE = /\.(test|spec)\.tsx?$/;

/**
 * The one file this process has replaced on disk, so a SIGNAL can put it back.
 *
 * ⚠ `finally` does not run on a default SIGINT or SIGTERM. Without this, Ctrl-C in the middle of a
 * run left the merge-base version of a test file in a developer's tree — and this guard's own dirty
 * check then refuses to run until it is cleaned up by hand. Routine in CI too: the workflow cancels
 * in-progress runs on a new push.
 */
let inFlight = null;
export function restoreInFlight() {
  if (!inFlight) return null;
  const { file, backup } = inFlight;
  inFlight = null;
  if (backup === null) rmSync(file, { force: true });
  else writeFileSync(file, backup, 'utf-8');
  return file;
}

/**
 * @param {{
 *   base: string, head: string,
 *   measure: (f: string) => {ok: boolean, out: string, json: unknown},
 *   listFiles: () => string[],
 *   headCommit?: (() => string) | null,
 *   log?: (s: string) => void,
 * }} deps
 */
export function check({ base, head, measure, listFiles, headCommit = null, log = () => {} }) {
  const dirty = tryRun('git', ['status', '--porcelain']);
  if (!dirty.ok) return { status: 2, reason: 'tree-unreadable' };
  const lines = dirty.out.split('\n').filter((l) => l.trim().length > 0);
  const trackedDirty = lines.filter((l) => !l.startsWith('??'));
  if (trackedDirty.length > 0) return { status: 2, reason: 'tree-dirty', trackedDirty };
  for (const u of lines.filter((l) => l.startsWith('??'))) log(`  note      untracked, ignored: ${u.slice(3)}`);

  // ⛔ The head side reads the WORKING TREE; the diff side reads the ref. Nothing but this makes them
  // the same commit. Measured with the tree on `main` and `head` pointing at a branch tip: the guard
  // compared head against head, found nothing and said so — a confident wrong answer with no skip
  // and no warning. A clean tree proves nothing about WHICH commit is checked out.
  if (headCommit) {
    const want = git(['rev-parse', `${head}^{commit}`]).trim();
    const have = headCommit();
    if (want !== have) return { status: 2, reason: 'head-mismatch', want, have };
  }

  const mb = mergeBase(base, head);
  const candidates = removedFrom(mb, head);
  if (candidates.length === 0) return { status: 0, reason: 'no-candidates', findings: [], skipped: [], moves: [], candidates: [] };

  // ⭐ THE HEALTH OF THE MEASURING DEVICE — the one thing this check claims to gate and did not. Two
  // paths made a broken runner look like a clean repository: an empty file list (every candidate then
  // skipped as "the runner does not run this file", `findings` empty, "nothing to report"), and a
  // runner that fails on every file. Neither is a judgement about the diff, so neither may be
  // reported as one. The list is asserted non-empty, and ONE file the diff does not touch is measured
  // as a POSITIVE CONTROL: if the instrument cannot count a file nobody changed, it cannot count one
  // somebody did.
  const roster = listFiles();
  if (roster.length === 0) return { status: 2, reason: 'runner-list-empty' };
  const untouched = roster.find((f) => !candidates.includes(f));
  if (untouched === undefined) {
    log('  note      every file the runner knows is a candidate; no positive control was possible');
  } else {
    const canary = measure(untouched);
    if (casesFor(canary.json, untouched) === null) {
      return { status: 2, reason: 'runner-unhealthy', canary: untouched, detail: reasonLine(canary.out) };
    }
    log(`  control   ${untouched} — the runner counts a file this diff does not touch`);
  }

  const budget = addedMultiset(mb, head, (f) => roster.includes(f));
  const findings = [];
  const skipped = [];
  const moves = [];

  for (const file of candidates) {
    // Asked FIRST, because everything after it costs a runner start of ~20 s. A diff removing lines
    // from twenty source files used to pay for all twenty before deciding they were not test files.
    if (!TEST_FILE.test(file)) {
      skipped.push([file, 'not a test file by name']);
      continue;
    }
    if (isPureMove(mb, head, file, budget)) {
      moves.push(file);
      log(`  move      ${file} — every lost line is matched by an added one in a file the runner runs`);
      continue;
    }

    let baseSource;
    try {
      baseSource = git(['show', `${mb}:${file}`]);
    } catch {
      skipped.push([file, 'the merge base has no such file']);
      continue;
    }

    // The HEAD side first, while the tree is still untouched. A file that is gone runs nothing.
    let headRunning = 0;
    const existedAtHead = existsSync(file);
    if (existedAtHead) {
      if (!roster.includes(file)) {
        skipped.push([file, "the runner does not run this file (it is not in the runner's own file list)"]);
        continue;
      }
      const m = measure(file);
      const c = casesFor(m.json, file);
      if (c === null) {
        skipped.push([file, `the runner produced no result for the head version: ${reasonLine(m.out)}`]);
        continue;
      }
      headRunning = c.ran;
    }

    const backup = existedAtHead ? readFileSync(file, 'utf-8') : null;
    const madeDir = existsSync(dirname(file)) ? null : dirname(file);
    inFlight = { file, backup };
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, baseSource, 'utf-8');
      const bm = measure(file);
      const bc = casesFor(bm.json, file);
      if (bc === null) {
        // Covers both "the runner does not collect this path" and "the base version cannot be built
        // against the new source". They need no telling apart: neither yields a passing case.
        skipped.push([file, `the runner produced no result for the base version: ${reasonLine(bm.out)}`]);
        continue;
      }
      if (bc.passed > headRunning) findings.push({ file, basePassing: bc.passed, headRunning });
      else log(`  same      ${file} — ${String(bc.passed)} case(s) passed before, ${String(headRunning)} run now; nothing was lost`);
    } finally {
      if (backup === null) rmSync(file, { force: true });
      else writeFileSync(file, backup, 'utf-8');
      // An empty directory is invisible to `git status`, so a test asserting a clean tree cannot see
      // one left behind. Removed here rather than asserted there.
      if (madeDir) { try { rmdirSync(madeDir); } catch { /* not empty — someone else's */ } }
      inFlight = null;
    }
  }
  return { status: findings.length > 0 ? 1 : 0, reason: 'checked', findings, skipped, moves, candidates };
}

/**
 * The line of a run that tells a human WHY.
 *
 * ⚠ Measured: taking the last non-empty line reported `⎯⎯⎯[4/4]⎯`, a progress separator.
 */
export function reasonLine(out) {
  const lines = out
    .split('\n')
    .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^(Duration|Start at|RUN|Test Files|Tests)\b/.test(l));
  // ⭐ TIERS, not one alternation — a real run taught the difference. The weak markers in tier 3 also
  // occur in output a test prints ON PURPOSE: a console warning reading "… is not a function" matched
  // first and beat the runner's own FAIL line further down, so a skip was explained by a
  // push-notification log that had nothing to do with it. A reason line naming the WRONG cause is
  // worse than a vague one: it sends a reader after a bug that is not there while the skip it was
  // meant to justify goes unexamined.
  const tiers = [
    /^FAIL\b|^(?:✖|×)\s|^Failed Tests\b/,
    /^(?:Uncaught\s+)?(?:Assertion|Type|Reference|Syntax|Range|Eval)?Error\b|\bTS\d{4}\b/,
    /\b(error|Error|FAIL|failed|Cannot|cannot|is not|undefined)\b/,
  ];
  for (const t of tiers) {
    const hit = lines.find((l) => t.test(l) && /[A-Za-z0-9]/.test(l));
    if (hit) return hit.slice(0, 150);
  }
  // ⚠ The separator survives stripping its own glyphs as `[4/4]`, which has digits, so the fallback
  // filters on letters-or-digits AFTER removing the rule characters — and that is only safe here, in
  // the fallback, where there is nothing better to say.
  const tail = lines.filter((l) => /[A-Za-z0-9]/.test(l.replace(/[─-╿⎯—–[\]/0-9]/g, '')));
  return tail.length > 0 ? tail[tail.length - 1].slice(0, 150) : '(the run produced no readable output)';
}

/**
 * The line the workflow requires before it believes an exit code.
 *
 * ⛔ An exit code ALONE cannot tell a verdict from a crash. node exits 1 for a module-load failure —
 * a missing file, a syntax error, a bad import — so a pull request that deletes or renames this very
 * script triggered the job (the script is in the workflow's `paths:`), node exited 1 with no output,
 * and the run announced a finding nobody had measured, green. No try/catch inside this file can catch
 * that: it is not running yet.
 */
export const VERDICT = { clean: 'VERDICT clean', report: 'VERDICT report' };

/**
 * What a result PRINTS and what it EXITS with — pulled out of `main` so it has a witness.
 *
 * ⛔ Nothing exercised `main` or the 0/1/2 contract, which is precisely why the workflow shipped
 * with its polarity inverted: the only thing that could have caught it was a test that runs the
 * decision. The rule a test can now hold onto: **a verdict line is printed on exit 0 and on exit 1
 * and never on exit 2.** Remove it from the report path and the workflow correctly reads every
 * finding as ill health — red on a finding, the one outcome this design forbids.
 */
export function render(r) {
  const lines = [];
  if (r.status === 2) {
    const why = {
      'tree-unreadable': 'could not read the working tree state',
      'tree-dirty': 'the working tree has tracked changes; this guard writes a file into the tree to run it, so it refuses rather than touch your work',
      'head-mismatch': 'the checked-out commit is not the head it was asked about, so the head side and the diff side would describe different code',
      'runner-list-empty': 'the runner enumerated NO test files, so nothing could have been measured',
      'runner-unhealthy': 'the runner cannot count a file this diff does not touch, so it cannot count one it does',
    }[r.reason] ?? r.reason;
    lines.push(`deleted-assertion-guard: ${why}`);
    if (r.want) lines.push(`    asked about ${r.want}, checked out ${String(r.have)}`);
    if (r.canary) lines.push(`    positive control: ${r.canary} — ${String(r.detail)}`);
    for (const l of (r.trackedDirty ?? []).slice(0, 10)) lines.push(`    ${l}`);
    return { lines, code: 2 };
  }
  if (r.reason === 'no-candidates') {
    lines.push(`deleted-assertion-guard: nothing to look at (this diff removes no lines from any tracked file) — ${VERDICT.clean}`);
    return { lines, code: 0 };
  }
  for (const [file, why] of r.skipped) lines.push(`  skip      ${file} — ${why}`);
  if (r.findings.length === 0) {
    lines.push(`deleted-assertion-guard: nothing to report (${String(r.candidates.length)} candidate(s) examined) — ${VERDICT.clean}`);
    return { lines, code: 0 };
  }
  lines.push('');
  for (const { file, basePassing, headRunning } of r.findings) {
    lines.push(`  REPORT  ${file}: ${String(basePassing)} case(s) passed before, ${String(headRunning)} run now — the missing ones still pass against the new source.`);
  }
  lines.push('');
  lines.push('  What this knows: that many cases held and no longer run, measured by the runner itself.');
  lines.push('  What it does NOT know, and cannot: whether something else now covers them. It compares');
  lines.push('  only the NUMBER of cases per file — deleting two while adding three keeps the number up');
  lines.push('  and does not appear here at all.');
  lines.push('  Nothing is blocked. If the removal was deliberate, the commit message is where to say so.');
  lines.push(`deleted-assertion-guard: ${VERDICT.report}`);
  return { lines, code: 1 };
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.log('deleted-assertion-guard: usage: node scripts/deleted-assertion-guard.mjs <base-ref> <head-ref>');
    process.exit(2);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      const f = restoreInFlight();
      if (f) console.log(`deleted-assertion-guard: interrupted; put ${f} back`);
      process.exit(2);
    });
  }
  let r;
  try {
    const env = { ...process.env, CI: '1' };
    r = check({
      base,
      head,
      headCommit: () => git(['rev-parse', 'HEAD']).trim(),
      // ⭐ `--reporter=json --outputFile`, never the summary on stdout: per file, per case, with
      // states, into a path the subject under test cannot write to.
      measure: (f) => {
        const dir = mkdtempSync(join(tmpdir(), 'delguard-'));
        const out = join(dir, 'result.json');
        const run = tryRun('npx', ['vitest', 'run', f, '--reporter=json', `--outputFile=${out}`], { env });
        let json = null;
        try { json = JSON.parse(readFileSync(out, 'utf-8')); } catch { /* the reason line says why */ }
        rmSync(dir, { recursive: true, force: true });
        return { ok: run.ok, out: run.out, json };
      },
      listFiles: () => {
        const l = tryRun('npx', ['vitest', 'list', '--filesOnly'], { env });
        // ⛔ THROWS on failure — it used to return `[]`. A vite config error, an OOM or a transform
        // failure anywhere in the glob produced an empty list, every candidate was skipped as "the
        // runner does not run this file", and the run reported "nothing to report" and passed green.
        // A failure to look is not a finding that there is nothing.
        if (!l.ok) throw new Error(`the runner could not enumerate its files: ${reasonLine(l.out)}`);
        return l.out.split('\n').map((s) => s.trim()).filter((s) => TEST_FILE.test(s));
      },
      log: console.log,
    });
  } catch (e) {
    restoreInFlight();
    console.log(`deleted-assertion-guard: could not check — ${String(e).split('\n')[0].slice(0, 160)}`);
    process.exit(2);
  }

  const decided = render(r);
  for (const l of decided.lines) console.log(l);
  process.exit(decided.code);
}

if (process.argv[1] && process.argv[1].endsWith('deleted-assertion-guard.mjs')) main();
