#!/usr/bin/env node
/**
 * disclosure-vocabulary-scan — pre-commit: WARN when a staged change adds a line that
 * points at internal tracking or marks work as put off. This is a public repo, and a
 * sentence like "filed as a row rather than built here" tells every reader that a
 * known gap exists and roughly where. It never refuses the commit.
 *
 *   exit 0  nothing found, or warnings printed
 *   exit 2  the staged diff could not be read — the scan did not run
 *
 * WHY A WARNING AND NOT A REFUSAL. What this looks for is meaning, and wording only
 * approximates it. A refusal teaches people to reword until the scan is quiet, and a
 * reworded gap is harder to find than a plainly named one. A warning asks the author
 * to decide, and the decision is one this script cannot make:
 *   · a sentence that documents a LIMIT OF A FEATURE (what it does not do, and that
 *     the direction is safe) is honest boundary documentation and stays;
 *   · a sentence that says a CHECK, LIMIT OR GATE has a gap, or names the internal
 *     record of one, goes.
 * Two narrow forms are refused elsewhere, at push time and in CI, by
 * `added-lines-guard.mjs`: a `DEF-` register id, and a short list of phrases about
 * security findings. A gap described in other words is refused by nothing, and warned about here
 * only when it uses the wording below.
 *
 * WHAT IS READ: the lines the commit adds, from the index (`git diff --cached`), as
 * `secret-pattern-scan.sh` does, so lines nobody touched never warn. A line that the
 * same staged change also REMOVES, anywhere, is a move and not new text, so it does
 * not warn either: moving a file or a block must not report every sentence in it.
 * Compared after trimming, so re-indenting a block is still a move.
 *
 * NOT covered, stated rather than implied: wording outside the lists below, a
 * sentence broken across two lines, commit messages and pull-request text. Bounded,
 * not exact.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diffLines, normalise } from './added-lines-guard.mjs';

/**
 * This file and its test hold the vocabulary on purpose. Nothing else is left out, the
 * other gates included: they talk about this vocabulary often and warn on such edits,
 * but a sentence there that says a check has a gap is the one that matters most.
 */
export const ABOUT_THE_VOCABULARY = new Set([
  'scripts/disclosure-vocabulary-scan.mjs', 'tests/disclosure-vocabulary-scan.test.ts',
]);

/** Wording that points at an internal record of open work. */
export const NAMES_A_RECORD = [
  /\bregister (row|entry|line)s?\b/i,
  /\bregistered as (its own |a |an )?(row|entry|finding|gap)\b/i,
  /\b(deferred|private|internal) register\b/i,
  /\bfiled as (a|an|its own) (row|register|finding|entry|issue)\b/i,
];

/** Wording that marks work as put off or a gap as left in place. */
export const PUTS_WORK_OFF = [
  // Not `filed against`/`under`: a fact is filed against a client, which is the product.
  /\bfiled\b(?!\s+(against|under)\b)/i,
  /\bout of scope (here|for this (change|PR|pull request))\b/i,
  /\bdeferred (until|to (a|the) (later|next|follow)|for (a )?later)/i,
  /\btracked separately\b/i,
  /\b(a|as a|in a) follow-?up\b(?!\s*(chips?|questions?|prompts?|messages?|turns?|suggestions?))/i,
  /\b(its|their) own (PR|pull request|change|commit|piece)\b/i,
  /\b(change|PR|pull request|piece) of (its|their) own\b/i,
  /\bknown (gap|hole)s?\b/i,
  // The marker, not the product's own TODO tasks.
  /\bTODO\s*[:(]/,
  /\b(findings?|gaps?|holes?|defects?)\b[^.]{0,30}\b(remains?|stays?|is|are|left|still) open\b/i,
  /\b((for|in|until) a later (change|PR|pull request|piece|release)|left for (a )?later)\b/i,
  /\bnot (addressed|handled|fixed|covered|touched|built|solved) here\b/i,
  // About a defect, not a pre-existing record: followed by a defect noun, or standing as
  // the statement itself (`pre-existing.`, `is pre-existing`, `PRE-EXISTING and filed`).
  /\bpre-?existing\b(?=[^.]{0,40}\b(gaps?|holes?|defects?|bugs?|problems?|issues?|findings?|violations?)\b)/i,
  /\b(is|was|are|were|it's)\s+pre-?existing\b|\bpre-?existing\s*([.;:]|and filed)/i,
];

/** What a line says, as a kind, or null. A line naming a record is reported as that. */
export function kindOf(line) {
  const text = normalise(line);
  if (NAMES_A_RECORD.some((r) => r.test(text))) return 'points at an internal record';
  if (PUTS_WORK_OFF.some((r) => r.test(text))) return 'marks work as put off';
  return null;
}

/** The staged diff's added lines that say one of the above, moves left out. */
export function warningsIn(diff) {
  const { added, removed } = diffLines(diff);
  const moved = new Set(removed.map((r) => r.text.trim()));
  const out = [];
  for (const a of added) {
    if (ABOUT_THE_VOCABULARY.has(a.path) || moved.has(a.text.trim())) continue;
    const kind = kindOf(a.text);
    if (kind !== null) out.push({ path: a.path, line: a.line, kind, text: a.text.trim() });
  }
  return out;
}

export function main() {
  let diff;
  try {
    // The same pinned form as the secret scan: explicit prefixes and rename
    // detection, staged bytes even for a file git would call binary.
    // Pinned against config that reshapes the diff, as in added-lines-guard: an empty
    // context line (`diff.suppressBlankEmpty`) would make the parser throw, and a warning
    // must not block a commit over a developer's settings.
    diff = execFileSync('git', ['--no-replace-objects', '-c', 'diff.suppressBlankEmpty=false', '-c', 'core.quotePath=false',
      'diff', '--cached', '--no-color', '--no-ext-diff', '--text', '--no-textconv', '--no-relative',
      '--src-prefix=a/', '--dst-prefix=b/', '-M', '-U0'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    console.error('\n✗ disclosure-vocabulary-scan: could not read the staged changes (not a git work tree?).');
    console.error('   Refusing to report a clean commit on a scan that did not run.\n');
    return 2;
  }
  let found;
  try {
    found = warningsIn(diff);
  } catch (e) {
    console.error(`\n✗ disclosure-vocabulary-scan: could not read the staged diff — ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  if (found.length === 0) return 0;
  console.log('\n⚠ Lines this commit adds that may tell the PUBLIC what is known and left open:\n');
  for (const f of found) console.log(`  ${f.path}:${f.line}: ${f.kind}\n      ${f.text.slice(0, 160)}`);
  console.log('\nThis is a warning; the commit goes ahead. For each line, decide:');
  console.log('  · it documents what a FEATURE does not do (and that this is safe) → keep it;');
  console.log('  · it says a check, limit or gate has a gap, or points at where open work is');
  console.log('    tracked → remove it, before this commit is pushed. Do not reword it: a gap');
  console.log('    described in other words is still described, and harder to find.\n');
  return 0;
}

// Through a symlinked path a lexical comparison never matches and main() never runs.
let invoked = null;
try {
  invoked = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
} catch {
  process.stderr.write(`disclosure-vocabulary-scan: could not resolve ${process.argv[1]}\n`);
  process.exitCode = 2;
}
if (invoked !== null && fileURLToPath(import.meta.url) === invoked) process.exit(main());
