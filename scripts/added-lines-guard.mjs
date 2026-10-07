#!/usr/bin/env node
/**
 * added-lines-guard — the lines every commit in a range ADDS, checked for what this
 * public repo does not carry: an internal register id (`DEF-…`), and wording that
 * marks a security finding as open or known.
 *
 *   scripts/public-repo-guard.sh check-commits <base-ref> <head-ref> [--allow-empty]
 *
 * That is the one entry point; it runs this file. Two callers: the pre-push hook,
 * which keeps an id from being PUBLISHED at all, and the required CI job, which
 * keeps it from being MERGED. Only the hook prevents the disclosure — on a public
 * repo a pushed commit is readable on the pull request whatever CI says later, and
 * a merged pull request's commit list cannot be changed. The job is the net under
 * the hook, for a push that skipped it. `--allow-empty` is the hook's: a push that
 * adds no commit has nothing to check and must not be refused.
 *
 * The CI step is only as protected as the workflow file: a `pull_request` run takes
 * the workflow from the pull request itself, so a pull request that edits that step
 * changes what judges it. Reading this script from the base commit stops a pull
 * request from changing the SCRIPT unnoticed, not from changing the workflow, which
 * a reviewer has to see.
 *
 * Exit 0: checked and clean · 1: found, the locations are printed · 2: could not
 * check (a ref that does not resolve, a diff it cannot read, no commits in the
 * range). 2 is not a pass, and the workflow fails on it like on 1.
 *
 * WHY PER COMMIT. `scripts/public-repo-guard.sh` already refuses an internal id in
 * the tracked tree at HEAD. That is the state that SURVIVES the branch, not what
 * the push PUBLISHES: an id one commit adds and a later commit removes is absent
 * from HEAD and still goes out with the push, readable on the PR page for good.
 * So every commit in base..head is read as a patch, and its added lines are what is
 * checked. Removed lines are not: their content is leaving. A MERGE commit is read
 * as what its author typed: the difference between git's own automatic merge and
 * the committed result (`--diff-merges=remerge`, git 2.36 or later), minus any line
 * that one of its parents already carries in the same file — a resolution that keeps
 * main's line did not write it. A clean merge of main into a branch adds nothing,
 * and a conflict resolution that types a new id into the merge is found. An octopus
 * merge, which git does not remerge, is refused rather than read as clean.
 *
 * WHAT IS CHECKED, and why only this:
 *   · any `DEF-` id, in any case and file. This repo names no register row: an id
 *     is a pointer into a register the public reader cannot open, and its slug
 *     names what it is about. A test that needs an id-SHAPED value assembles an
 *     invented one (`'DEF-' + 'example'`), which is not read as an id.
 *   · wording that marks a security finding as open or known, German and English
 *     (see OPEN_FINDING). A scanner's all-clear ("no known vulnerabilities") is
 *     not such wording.
 * Spellings produced by accident count as the plain form: fullwidth letters, the
 * Cyrillic and Greek letters that look like `E`, invisible format and combining
 * characters inside an id, the Unicode hyphens, and the NUL bytes of a UTF-16 file.
 * A line carrying `public-repo-guard:allow` is not refused, as in the tree scan —
 * for the wording too, because fictional demo content can need it; a reviewer sees
 * the pragma. The tree scan's whole-file allow-list does not apply here: this check
 * is stricter there. Removing invisible characters happens before the id is
 * matched, so a combining mark between a letter and an id hides the id.
 *
 * NOT covered, stated rather than implied: an id written with escapes, assembled
 * from pieces, or in a file PATH; wording outside the list, or broken across two
 * lines; commit messages, PR titles and bodies, and branch names. Those texts may
 * legitimately carry some ids, and which ones is decided by a reference that is
 * not public, so they are checked before publishing, outside this repo. Bounded,
 * not exact.
 *
 * The output names the commit, the file and the line, and the kind of finding —
 * never the matched text, so a public CI log does not print it a second time.
 *
 * No imports beyond node built-ins, so the workflow can run the copy from the
 * pull request's BASE commit on its own.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PRAGMA = 'public-repo-guard:allow';

/** Not after a letter, so an id right after an underscore counts; any case. */
const DEF_ID = /(?<![A-Za-z])DEF-[a-z0-9][\w-]*/gi;

/**
 * Wording that marks a security finding as open or known, German and English.
 * Written by hand and kept GENERIC on purpose: a list in a public repo that was
 * derived from actual findings — even only in which words it picks — would itself
 * say what to look for. It is never generated from any internal source.
 */
export const OPEN_FINDING = new RegExp(
  [
    String.raw`offene[rnms]?\s+(Register|Security|Sicherheits)-?[Bb]efund`,
    String.raw`offene[rnms]?\s+(Security|Sicherheits)-?Zeile`,
    String.raw`(Register|Security|Sicherheits)-?[Bb]efund\w*\s+(ist|sind|bleib\w*)\s+((noch|weiterhin)\s+)?offen`,
    String.raw`open\s+security\s+(finding|row|issue)s?\b`,
    String.raw`security\s+(finding|row|issue)s?\s+((is|are|remains?|stays?)\s+)?(still\s+)?open\b`,
    String.raw`(?<!\bno\s)known\s+vulnerabilit(y|ies)`,
    String.raw`unpatched\s+vulnerabilit`,
    String.raw`bekannte[rnms]?\s+(Sicherheitslücke|Schwachstelle)`,
    String.raw`offene[rnms]?\s+(Sicherheitslücke|Schwachstelle)`,
  ].join('|'),
  'gi',
);

/**
 * Accidental spellings folded to the plain form: fullwidth letters (NFKC), the
 * Cyrillic and Greek capital and small `E`, invisible format characters (`\p{Cf}`:
 * zero-width, soft hyphen, direction marks, tags) and combining marks (`\p{Mn}`),
 * NUL bytes (a UTF-16 file read as text), the Unicode hyphens and the en dash. The
 * em dash only right after `DEF`: elsewhere it is punctuation.
 */
export function normalise(text) {
  return text
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Mn}\u0000]/gu, '')
    .replace(/[\u0415\u0395]/g, 'E')
    .replace(/[\u0435\u03B5]/g, 'e')
    .replace(/(?<![A-Za-z])DEF[\u2014\u2015\uFE58]/gi, 'DEF-')
    .replace(/[\u2010-\u2013\u2212\uFE63]/g, '-');
}

/** The kinds of finding in one line of text (empty when clean or allowed). */
export function findingsIn(line) {
  if (line.includes(PRAGMA)) return [];
  const text = normalise(line);
  const kinds = [];
  if (text.match(DEF_ID)) kinds.push('internal register id');
  if (text.match(OPEN_FINDING)) kinds.push('wording that marks a security finding as open or known');
  return kinds;
}

/**
 * The added lines of `git log -p` output, as { commit, path, line, text }. Hunks
 * are consumed by the counts in their `@@` header, so an added line whose content
 * starts with `++` is still content. A line inside a hunk that is none of
 * `+ - \ ` (space) throws: a diff reshaped by config would otherwise drop added
 * lines silently.
 */
export function addedLines(diff) {
  return diffLines(diff).added;
}

/**
 * The added and the removed lines of a diff, read as `addedLines` describes. A
 * removed line carries { commit, text }.
 */
export function diffLines(diff) {
  const added = [];
  const removed = [];
  let commit = null;
  let path = null;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const l of diff.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (l.startsWith('+')) {
        added.push({ commit, path, line, text: l.slice(1) });
        line++;
        newLeft--;
      } else if (l.startsWith('-')) {
        removed.push({ commit, text: l.slice(1) });
        oldLeft--;
      } else if (l.startsWith(' ')) {
        line++;
        oldLeft--;
        newLeft--;
      } else if (!l.startsWith('\\')) {
        // The line itself is not quoted: this message can reach a public CI log.
        throw new Error(`unexpected line inside a hunk of ${path}`);
      }
      continue;
    }
    if (l.startsWith('@@@')) throw new Error(`a combined diff hunk in ${path}, which this check cannot read`);
    const c = l.match(/^commit ([0-9a-f]+)$/);
    if (c) {
      commit = c[1];
      continue;
    }
    if (l.startsWith('+++ ')) {
      path = l.slice(4).replace(/\t$/, '').replace(/^b\//, '');
      continue;
    }
    const h = l.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      line = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
    }
  }
  return { added, removed };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

/**
 * Every commit's patch in base..head, a merge as its remerge diff. Pinned against
 * config that would hide or reshape added lines: binary detection (`--text`), copy
 * detection (`-M`, renames only), blank context lines, a root commit shown without
 * its patch (`log.showRoot`), textconv and external diff drivers, paths relative to
 * a subdirectory, quoted names, colour, prefixes, replace refs.
 */
function patchesOf(base, head) {
  return git(['--no-replace-objects', '-c', 'diff.suppressBlankEmpty=false', '-c', 'core.quotePath=false',
    '-c', 'log.showRoot=true',
    'log', '-p', '--diff-merges=remerge', '--format=commit %H', '--no-color', '--no-textconv', '--no-ext-diff',
    '--no-relative', '--text', '-M', '--unified=0', '--src-prefix=a/', '--dst-prefix=b/', `${base}..${head}`]);
}

/**
 * A merge's remerge diff shows the lines of a conflict resolution as added, also
 * those it kept from a parent. Those were written by the parent's commit, which is
 * read on its own or is already on main, so a merge's added line counts only when
 * no parent carries it in the same file.
 */
function withoutParentLines(added, base, head) {
  const merges = new Set(git(['--no-replace-objects', 'rev-list', '--merges', `${base}..${head}`]).split('\n').filter(Boolean));
  if (merges.size === 0) return added;
  const parentLines = new Map();
  const linesOf = (commit, path) => {
    const key = `${commit}\0${path}`;
    if (!parentLines.has(key)) {
      const set = new Set();
      const parents = git(['--no-replace-objects', 'rev-list', '--parents', '-n', '1', commit]).trim().split(' ').slice(1);
      for (const p of parents) {
        let blob = '';
        try {
          blob = git(['--no-replace-objects', 'show', `${p}:${path}`]);
        } catch {
          continue; // the file is new to this parent
        }
        for (const l of blob.split('\n')) set.add(l);
      }
      parentLines.set(key, set);
    }
    return parentLines.get(key);
  };
  return added.filter((a) => !merges.has(a.commit) || !linesOf(a.commit, a.path).has(a.text));
}

export function main(argv) {
  const args = argv.slice(2);
  const allowEmpty = args.includes('--allow-empty');
  const [base, head, ...rest] = args.filter((a) => a !== '--allow-empty');
  if (!base || !head || rest.length > 0 || base.startsWith('-') || head.startsWith('-')) {
    console.error('usage: public-repo-guard.sh check-commits <base-ref> <head-ref> [--allow-empty]');
    return 2;
  }
  let commits;
  let added;
  try {
    // Resolved first and on its own: an unresolvable ref must not read as an
    // empty range, i.e. as clean.
    commits = git(['--no-replace-objects', 'rev-list', `${base}..${head}`]).split('\n').filter(Boolean);
    const octopus = git(['--no-replace-objects', 'rev-list', '--min-parents=3', `${base}..${head}`]).split('\n').filter(Boolean);
    if (octopus.length > 0) {
      console.error(`added-lines-guard: ${octopus[0].slice(0, 9)} is an octopus merge, which git cannot show as what its author typed — refusing to call the range clean.`);
      return 2;
    }
    added = withoutParentLines(addedLines(patchesOf(base, head)), base, head);
  } catch (e) {
    const why = String(e?.stderr ?? '').trim().split('\n')[0] || (e instanceof Error ? e.message.split('\n')[0] : String(e));
    console.error(`added-lines-guard: could not read ${base}..${head} — ${why}`);
    console.error('In CI this usually means the checkout is too shallow; it needs fetch-depth: 0.');
    return 2;
  }
  if (commits.length === 0 && allowEmpty) {
    console.log(`added-lines-guard: ${base}..${head} adds no commit — nothing to check.`);
    return 0;
  }
  if (commits.length === 0) {
    // A pull request always adds at least one commit, so an empty range means the
    // refs are not the ones meant. Zero must not look like a walk that found nothing.
    console.error(`added-lines-guard: ${base}..${head} holds no commit — refusing to call it clean.`);
    return 2;
  }
  let total = 0;
  for (const a of added) {
    for (const kind of findingsIn(a.text)) {
      console.log(`commit ${a.commit.slice(0, 9)} ${a.path}:${a.line}: ${kind}`);
      total++;
    }
  }
  if (total > 0) {
    console.error(`\nadded-lines-guard: ${total} finding(s) in lines this range adds. This is the PUBLIC repo.`);
    console.error('Describe the behaviour instead of naming an internal id; describe the change, not an open finding.');
    console.error("An id-shaped test value: assemble an invented one, e.g. 'DEF-' + 'example'.");
    console.error('Rewrite the commit that ADDED it (rebase, amend) before the merge — a later commit that removes');
    console.error('it does not help: the earlier commit is still pushed and stays readable on the pull request.');
    return 1;
  }
  console.log(`added-lines-guard: clean ✓ (${commits.length} commit(s), ${added.length} added line(s) read)`);
  return 0;
}

// Through a symlinked path a lexical comparison never matches, main() never runs
// and the process exits 0 with no output — which a caller reads as clean.
let invoked = null;
try {
  invoked = process.argv[1] === undefined ? null : realpathSync(process.argv[1]);
} catch {
  process.stderr.write(`added-lines-guard: could not resolve ${process.argv[1]}\n`);
  process.exitCode = 2;
}
if (invoked !== null && fileURLToPath(import.meta.url) === invoked) process.exit(main(process.argv));
