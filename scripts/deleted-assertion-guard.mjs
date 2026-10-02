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
 * and the blind spots below break nothing, because nothing is allowed to rest on this. What IS gated
 * is the instrument's HEALTH — a check that silently stops looking still reads as coverage.
 *
 * ⭐ WHAT IT MEASURES, in two runs of the runner and no heuristics:
 *   1. one HEAD run over the candidate files, the files this diff adds lines to, and one file it
 *      does not touch (the positive control) → the NAMES of every case that actually ran.
 *   2. one BASE run with every candidate's merge-base version written over it → the NAMES of every
 *      case that PASSED against the new source.
 *   3. report, per candidate, the names that passed in (2) and run nowhere in (1).
 *
 * ⭐⭐ NAMES, NOT COUNTS, AND THAT IS WHAT DELETED THE HEURISTICS. Three earlier versions of this
 * file compared NUMBERS, and every defect the gates found afterwards was a consequence:
 *   · A moved case had to be recognised by matching its removed LINES against the diff's added
 *     lines. That machinery — a multiset, a budget, a filter on where the line landed — grew a
 *     defect per round. With one budget shared across files it even named the WRONG FILE: a pull
 *     request that deletes from A and moves the identical lines out of B attributed the move and the
 *     finding by git's file ORDER, so swapping two filenames swapped who was accused. For a reporter
 *     that is the most expensive failure there is: it sends a reader to a file that lost nothing.
 *     A case carries its own name. If it runs anywhere at head, it moved; that is a measurement.
 *   · A count cannot say WHICH cases went missing. A list of names can, and it is what the reader
 *     actually needs.
 * The whole move apparatus is gone. So is the per-candidate pair of runner starts: 30 candidates used
 * to cost 61 invocations and about 13 minutes against a 20-minute timeout; it is 2 invocations now.
 *
 * ⭐⭐ THE NUMBERS COME FROM THE RUNNER'S JSON, NOT FROM ITS PROSE. The first version read
 * `Tests … (N)` out of the human-readable summary, and a refutation round measured that **the guard
 * was dead in the only environment it runs in**: vitest colours that line whenever `CI` is in the
 * environment (tinyrainbow never consults `isTTY`), so it arrives as `ESC[2m      Tests ESC[22m …`
 * and `^\s*Tests` cannot match — ESC is not `\s`. Every candidate was skipped as "collected no
 * cases" and the job printed "nothing to report", green. It looked right locally for one reason: the
 * harness sets `CLAUDECODE`, vitest's `isAgent` is then true and it disables colour. **The instrument
 * had been validated where it works instead of where it runs.** Reading the JSON also kills three
 * defects of the same family: `Tests  no tests` parsed as "no count" rather than zero; `it.skip` and
 * `it.todo` counting toward the total, so skipping four cases changed nothing; and the summary being
 * read from the same stream the SUBJECT writes to, so one `console.log('      Tests  99 passed (99)')`
 * inside a test silenced every finding in its file.
 *
 * ⛔ WHY CASES AND NOT "REMOVED LINES" — the first premise this file got wrong, and in the direction
 * that gets a guard switched off. "Removed test lines" is a proxy for "removed coverage", and a bad
 * one: a retitled `it()`, a renamed variable, a prettier re-wrap — each removes lines and removes no
 * coverage. Measured on a real file: a change that only retitled three tests was reported as a
 * finding. A guard that reports every rename is switched off in days.
 *
 * ⭐ "PASSED", NOT "DECLARED", is what makes the forced case disappear: a base version that cannot
 * compile against the new source passes nothing, so it can never produce a finding — no special
 * case, and no branch whose order there is to get wrong.
 *
 * ⭐⭐ AND "RAN NOTHING" IS NOT A JUDGEMENT ABOUT THE DIFF. This distinction cost two rounds to find
 * and the data carries it exactly: a file emptied of every case reports **0 assertions**, while a
 * file whose cases exist but did not run reports **assertions with status `skipped`**. The second
 * shape is ordinary here — 24 files gate their whole suite, 21 of them `tests/online/*` behind
 * `describe.skipIf(!hasApiKey())`, and CI has no key — and a `beforeAll` that throws produces it too.
 * Treated as a count, both shapes read as zero: a gated suite then reported "nothing was lost" while
 * cases were deleted from it, and a pull request that merely ADDED a precondition reported every case
 * in the file as lost, in a sentence that contradicted itself. So: cases that exist and did not run
 * mean this file cannot be judged, and it is skipped with that reason.
 *
 * ⚠ ITS BLIND SPOT, stated here AND in its own output, because a report must say what it KNOWS: a
 * case that is deleted and a DIFFERENT case added under the same name reads as the same case. And a
 * case renamed and genuinely rewritten reads as lost — which is the conservative direction. Closing
 * the first needs the property instead of the proxy (coverage instrumentation), which is a different
 * and much larger instrument. Deliberately out of scope, not pending.
 *
 * ⚠ WHAT IT DOES NOT SEE AT ALL: assertions outside a test file (a `satisfies` weld, a type
 * constraint, a guard clause in `src/`); and two rename shapes, because `-M` does not make renames
 * safe, it moves the problem across a SIMILARITY THRESHOLD and the behaviour flips at it. Above
 * git's default 50% the pair is `R`, which `--diff-filter=MD` does not select, so a rename that also
 * deletes cases is invisible — and so is a test file renamed OUT of the runner's include globs,
 * which is `R100` and loses 100% of its coverage silently. Below the threshold it is plain `D`+`A`,
 * so the old path IS examined and every case in it reads as lost, which is true of that path and
 * says nothing about where the cases went. Registered, not half-built here.
 *
 * ⛔ IT REFUSES ON A TRACKED MODIFICATION. It writes files into the tree to run them. A tracked
 * change means the run would not measure HEAD anyway, and it could be work to clobber. An UNTRACKED
 * file is named and ignored — refusing on those made an earlier version exit 2 on an editor
 * leftover, and since exit 2 reports no finding, the guard would have been permanently silent while
 * still counting as a check. It also refuses when the checked-out commit is not the `head` it was
 * given: the head side reads the WORKING TREE while the diff side reads the ref, and with the two
 * out of step the guard compared head against head and reported nothing, confidently.
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

/** Parse `--numstat -z` records into `{added, deleted, path}`, taking the DESTINATION of a rename. */
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

/**
 * Files the diff ADDS lines to — where a case could have moved TO.
 *
 * These are measured at head, not reasoned about. That is the whole replacement for the old move
 * detection: a case that moved is a case that runs somewhere, and the somewhere is in this list.
 */
export function addedTo(base, head) {
  return numstatZ(git(['diff', '-M', '-z', '--diff-filter=ACMR', '--numstat', `${base}...${head}`]))
    .filter((r) => r.added !== '-' && Number(r.added) > 0)
    .map((r) => r.path);
}

/**
 * The runner's JSON, per file: which case NAMES ran, which PASSED, and how many cases it declared
 * at all. Keyed by resolved absolute path, because `testResults[].name` is absolute.
 *
 * ⭐ `declared` is the third number and it is the one two rounds of gates were missing. `ran` is 0
 * for two completely different situations — a file emptied of every case (declared 0) and a file
 * whose cases exist but did not run (declared > 0, all `skipped`). Only the first is a statement
 * about the diff.
 *
 * ⭐ `passed`/`failed` is what counts as RAN. `skipped` and `todo` appear in the runner's own total,
 * so counting the total let a pull request convert four cases to `it.skip` with the number
 * unchanged — all four stopped running and nothing was reported. A case that does not run is not
 * coverage.
 */
export function fileResults(json) {
  const byFile = new Map();
  for (const entry of json?.testResults ?? []) {
    const ran = new Set();
    const passed = new Set();
    let declared = 0;
    for (const a of entry.assertionResults ?? []) {
      declared += 1;
      const name = String(a.fullName ?? a.title ?? '');
      if (a.status === 'passed' || a.status === 'failed') ran.add(name);
      if (a.status === 'passed') passed.add(name);
    }
    byFile.set(resolve(String(entry.name)), { ran, passed, declared });
  }
  return byFile;
}

const TEST_FILE = /\.(test|spec)\.tsx?$/;

/**
 * The files this process has replaced on disk, so a SIGNAL can put them back.
 *
 * ⚠ `finally` does not run on a default SIGINT or SIGTERM. Without this, Ctrl-C mid-run left
 * merge-base versions of test files in a developer's tree — and this guard's own dirty check then
 * refuses to run until they are cleaned up by hand. Routine in CI too: the workflow cancels
 * in-progress runs on a new push.
 */
let inFlight = [];
export function restoreInFlight() {
  const put = inFlight;
  inFlight = [];
  for (const { file, backup, madeDir } of put) {
    if (backup === null) rmSync(file, { force: true });
    else writeFileSync(file, backup, 'utf-8');
    if (madeDir) { try { rmdirSync(madeDir); } catch { /* not empty — someone else's */ } }
  }
  return put.map((p) => p.file);
}

/**
 * @param {{
 *   base: string, head: string,
 *   measure: (files: string[]) => {ok: boolean, out: string, json: unknown},
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
  // the same commit. Measured with the tree on `main` and `head` at a branch tip: the guard compared
  // head against head, found nothing and said so — a confident wrong answer with no skip and no
  // warning. A clean tree proves nothing about WHICH commit is checked out.
  if (headCommit) {
    const want = git(['rev-parse', `${head}^{commit}`]).trim();
    const have = headCommit();
    if (want !== have) return { status: 2, reason: 'head-mismatch', want, have };
  }

  const mb = mergeBase(base, head);
  const skipped = [];
  const touched = removedFrom(mb, head);
  const candidates = [];
  for (const f of touched) {
    // Asked before anything else: a source file can lose lines without being a test, and it used to
    // cost a runner start before being dropped.
    if (TEST_FILE.test(f)) candidates.push(f);
    else skipped.push([f, 'not a test file by name']);
  }
  if (candidates.length === 0) {
    return { status: 0, reason: 'no-candidates', findings: [], skipped, candidates: [], touched };
  }

  const roster = listFiles();
  // ⛔ An empty list used to mean "the runner runs none of these", so every candidate was skipped and
  // the run printed "nothing to report", green. A failure to look is not a finding that there is
  // nothing to see.
  if (roster.length === 0) return { status: 2, reason: 'runner-list-empty' };

  const rosterSet = new Set(roster);
  const destinations = addedTo(mb, head).filter((f) => rosterSet.has(f) && !candidates.includes(f));
  // ⭐ ONE file this diff does not touch, measured in the same run as the positive control. It costs
  // no extra invocation, and it is the only thing standing between a wedged toolchain and a green
  // "nothing to report": a collect error yields an entry with ZERO cases, which an earlier version
  // accepted as healthy because it only asked whether an entry existed.
  const control = roster.find((f) => !candidates.includes(f) && !destinations.includes(f));

  const headFiles = [...candidates.filter((f) => existsSync(f)), ...destinations];
  if (control) headFiles.push(control);
  const headRun = headFiles.length > 0 ? measure(headFiles) : { ok: true, out: '', json: { testResults: [] } };
  const headByFile = fileResults(headRun.json);

  if (control) {
    const c = headByFile.get(resolve(control));
    // ⭐ `ran.size >= 1`, not "an entry exists". That predicate is the finding of a second gate round:
    // a file the runner failed to collect still gets an entry, with no cases in it, so "an entry
    // exists" called a dead toolchain healthy and printed a control line that had counted nothing.
    if (!c || c.ran.size === 0) {
      return { status: 2, reason: 'runner-unhealthy', canary: control, detail: reasonLine(headRun.out) };
    }
    log(`  control   ${control} — the runner ran ${String(c.ran.size)} case(s) in a file this diff does not touch`);
  } else {
    log('  note      every file the runner knows is a candidate or a destination; no positive control was possible');
  }

  // Every case that runs anywhere in the MEASURED set — the candidates plus the files this diff adds
  // lines to. A case that moved between files is in here under its own name, which is why no
  // line-level move detection is needed, or wanted.
  //
  // ⚠ Deliberately NOT every file in the repository. A case with the same name in a file the pull
  // request never touches is a DIFFERENT test, and deleting this one is still a loss of this file's
  // coverage. Absolution means "the diff put it somewhere", not "the name exists somewhere".
  const ranAtHead = new Set();
  for (const r of headByFile.values()) for (const n of r.ran) ranAtHead.add(n);

  // Write every candidate's base version at once and measure them in ONE run. Verified: a file the
  // runner cannot collect does not suppress the others in the same invocation.
  const sources = new Map();
  for (const file of candidates) {
    try {
      sources.set(file, git(['show', `${mb}:${file}`]));
    } catch {
      skipped.push([file, 'the merge base has no such file']);
    }
  }
  const findings = [];
  inFlight = [];
  try {
    for (const [file, body] of sources) {
      const madeDir = existsSync(dirname(file)) ? null : dirname(file);
      inFlight.push({ file, backup: existsSync(file) ? readFileSync(file, 'utf-8') : null, madeDir });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body, 'utf-8');
    }
    const baseRun = sources.size > 0 ? measure([...sources.keys()]) : { ok: true, out: '', json: { testResults: [] } };
    const baseByFile = fileResults(baseRun.json);

    for (const file of sources.keys()) {
      const b = baseByFile.get(resolve(file));
      if (!b) {
        skipped.push([file, `the runner produced no result for the base version: ${reasonLine(baseRun.out)}`]);
        continue;
      }
      if (b.passed.size === 0) {
        // Nothing held, so nothing can have been lost. Both causes land here and neither needs
        // telling apart for the verdict — but the reason says which, because they read differently.
        skipped.push([file, b.declared === 0
          ? 'the base version declares no cases, so there is nothing it could have lost'
          : `the base version ran none of its ${String(b.declared)} case(s) against the new source — it cannot be built, or it is gated`]);
        continue;
      }
      const h = headByFile.get(resolve(file));
      if (h && h.ran.size === 0 && h.declared > 0) {
        // ⭐ The head version still DECLARES cases and ran none of them: gated, or a precondition
        // failed. Reporting that as a loss produced a self-contradicting sentence — "the missing ones
        // still pass" about cases that are right there in the file — for pull requests that only
        // ADDED a precondition.
        skipped.push([file, `the head version declares ${String(h.declared)} case(s) and ran none of them, so this file cannot be judged (gated, or a precondition failed)`]);
        continue;
      }
      // ⭐⭐ THE COUNT IS THE TRIGGER, THE NAMES ARE THE ATTRIBUTION — and the first draft of this
      // rebuild had only the names, which brought the very first false alarm back one level up. A
      // pure RETITLE changes every name while losing nothing: `it('does X')` becoming
      // `it('does X correctly')` leaves the base name running nowhere, so names alone reported a
      // loss for exactly the change that made the line-based version unusable. The case COUNT is
      // retitle-immune, so it decides WHETHER to speak; the names decide WHAT to say.
      //
      // ⭐ And the second conjunct falls out of the first rather than being added to it: a case that
      // MOVED lowers this file's count, so the count alone would report every move. Its name runs in
      // the destination, so the attribution comes back empty — and an empty attribution is silence.
      // Both conditions together are what no single one of the three earlier designs managed.
      const unmatched = [...b.passed].filter((n) => !ranAtHead.has(n));
      const headRunning = h ? h.ran.size : 0;
      if (b.passed.size > headRunning && unmatched.length > 0) {
        findings.push({ file, lost: unmatched, basePassing: b.passed.size, headRunning });
      } else if (b.passed.size <= headRunning) {
        log(`  same      ${file} — ${String(b.passed.size)} case(s) passed before, ${String(headRunning)} run now; the count did not drop`);
      } else {
        log(`  move      ${file} — the count dropped, but every case that passed before runs somewhere at head`);
      }
    }
  } finally {
    restoreInFlight();
  }
  return { status: findings.length > 0 ? 1 : 0, reason: 'checked', findings, skipped, candidates, touched };
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
  // worse than a vague one: it sends a reader after a bug that is not there.
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
  // filters on letters after removing rule characters, brackets and digits.
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
 * ⛔ Nothing exercised `main` or the 0/1/2 contract, which is precisely why the workflow shipped with
 * its polarity inverted: the only thing that could have caught it was a test that runs the decision.
 * The rule a test can hold onto: **a verdict line is printed on exit 0 and on exit 1 and never on
 * exit 2.** Remove it from the report path and the workflow correctly reads every finding as ill
 * health — red on a finding, the one outcome this design forbids.
 */
export function render(r) {
  const lines = [];
  if (r.status === 2) {
    const why = {
      'tree-unreadable': 'could not read the working tree state',
      'tree-dirty': 'the working tree has tracked changes; this guard writes files into the tree to run them, so it refuses rather than touch your work',
      'head-mismatch': 'the checked-out commit is not the head it was asked about, so the head side and the diff side would describe different code',
      'runner-list-empty': 'the runner enumerated NO test files, so nothing could have been measured',
      'runner-unhealthy': 'the runner ran no case in a file this diff does not touch, so it cannot be trusted about a file it does',
    }[r.reason] ?? `unknown reason: ${String(r.reason)}`;
    lines.push(`deleted-assertion-guard: ${why}`);
    if (r.want) lines.push(`    asked about ${r.want}, checked out ${String(r.have)}`);
    if (r.canary) lines.push(`    positive control: ${r.canary} — ${String(r.detail)}`);
    for (const l of (r.trackedDirty ?? []).slice(0, 10)) lines.push(`    ${l}`);
    return { lines, code: 2 };
  }
  if (r.reason === 'no-candidates') {
    // ⚠ Says what it read, not what is true. An earlier wording claimed "this diff removes no lines
    // from any tracked file", which a rename that dropped four cases made false: git classified the
    // pair as `R`, `--diff-filter=MD` excluded it, and the sentence asserted the opposite of the
    // truth while attaching a verdict the workflow believes.
    lines.push(`deleted-assertion-guard: no test file in this diff loses lines in a shape this reads (\`--diff-filter=MD\`, so a rename above git's similarity threshold is not read) — ${VERDICT.clean}`);
    for (const [file, why] of r.skipped) lines.push(`  skip      ${file} — ${why}`);
    return { lines, code: 0 };
  }
  for (const [file, why] of r.skipped) lines.push(`  skip      ${file} — ${why}`);
  if (r.findings.length === 0) {
    lines.push(`deleted-assertion-guard: nothing to report (${String(r.candidates.length)} candidate(s) examined) — ${VERDICT.clean}`);
    return { lines, code: 0 };
  }
  lines.push('');
  for (const { file, lost, basePassing, headRunning } of r.findings) {
    lines.push(`  REPORT  ${file}: ${String(lost.length)} of ${String(basePassing)} case(s) that passed before run nowhere now (${String(headRunning)} still run in this file):`);
    for (const n of lost.slice(0, 20)) lines.push(`            · ${n}`);
    if (lost.length > 20) lines.push(`            … and ${String(lost.length - 20)} more`);
  }
  lines.push('');
  lines.push('  What this knows: the case COUNT in this file dropped, and these cases passed against');
  lines.push('  the NEW source while running nowhere at head — not here and not in any file this diff');
  lines.push('  adds lines to, so they did not move. The count is what decides to speak: a pure retitle');
  lines.push('  keeps it and is silent.');
  lines.push('  What it does NOT know: a case that was BOTH retitled and kept appears in the list above,');
  lines.push('  because its old name stopped running. The count says how many are genuinely gone; the');
  lines.push('  names say which to look at. And a case deleted while another is added keeps the count up');
  lines.push('  and does not appear at all.');
  lines.push('  Nothing is blocked. If the removal was deliberate, the commit message is where to say so.');
  lines.push(`deleted-assertion-guard: ${VERDICT.report}`);
  return { lines, code: 1 };
}

/** The runner, as the only thing `main` adds over `check` — exported so a test can measure it for real. */
export function vitestMeasure(env) {
  return (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'delguard-'));
    const out = join(dir, 'result.json');
    const run = tryRun('npx', ['vitest', 'run', ...files, '--reporter=json', `--outputFile=${out}`], { env });
    let json = null;
    try { json = JSON.parse(readFileSync(out, 'utf-8')); } catch { /* the reason line says why */ }
    rmSync(dir, { recursive: true, force: true });
    return { ok: run.ok, out: run.out, json };
  };
}

/** The runner's own file list — exported for the same reason. */
export function vitestRoster(env) {
  return () => {
    const l = tryRun('npx', ['vitest', 'list', '--filesOnly'], { env });
    // ⛔ THROWS on failure — it used to return `[]`. A vite config error, an OOM or a transform
    // failure anywhere in the glob produced an empty list, every candidate was skipped as "the runner
    // does not run this file", and the run reported "nothing to report" and passed green.
    if (!l.ok) throw new Error(`the runner could not enumerate its files: ${reasonLine(l.out)}`);
    return l.out.split('\n').map((s) => s.trim()).filter((s) => TEST_FILE.test(s));
  };
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.log('deleted-assertion-guard: usage: node scripts/deleted-assertion-guard.mjs <base-ref> <head-ref>');
    process.exit(2);
  }
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      const put = restoreInFlight();
      if (put.length > 0) console.log(`deleted-assertion-guard: interrupted; put back ${put.join(', ')}`);
      process.exit(2);
    });
  }
  let r;
  try {
    // ⚠ `CI: '1'` is forced, and it is not cosmetic: it sets `allowOnly: false`, so a stray `it.only`
    // becomes a failed case rather than a passing one on both sides, which keeps the two runs
    // comparable. It also means the runner's output is coloured, which is why nothing here parses it.
    const env = { ...process.env, CI: '1' };
    r = check({
      base,
      head,
      headCommit: () => git(['rev-parse', 'HEAD']).trim(),
      measure: vitestMeasure(env),
      listFiles: vitestRoster(env),
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
