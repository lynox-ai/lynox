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
 *   · a raw invisible character (see INVISIBLE): every format character and
 *     default-ignorable code point (direction controls, zero-width characters,
 *     joiners, invisible operators, the byte order mark, the soft hyphen, the
 *     Hangul fillers, variation selectors, tag characters), the line terminators
 *     U+2028 and U+2029, a carriage return inside a line, and a NUL byte. A reader
 *     cannot see them; direction controls can show a line in another order than the
 *     one it runs in, invisible letters can make two names that read the same, and
 *     U+2028 ends a JavaScript line that git shows as one. A test, a comment or copy
 *     that needs one writes its escape (`\u202E`), the same string at runtime. The
 *     exceptions are by position inside an emoji (see emojiParts) and by file for
 *     data (isBinaryFile: an extension on a fixed list AND a NUL byte, never one
 *     alone). The pragma does not let one pass: a direction control can rearrange
 *     how the pragma's own line reads. A file NAME is read for them too, and printed
 *     with them escaped. Only added lines are read, so a file that already carries
 *     one is not refused until a commit adds such a line.
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
 * lines; commit messages, PR titles and bodies, and branch names (also for
 * invisible characters; with squash merges the public message is written at the
 * merge). A text file saved as UTF-16 is refused for its NUL bytes rather than read
 * for the characters it encodes (the repo carries none). A pull request that went
 * green before this rule merged stays green against the older base copy until its
 * check runs again. Those texts may
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

/**
 * Characters a reader cannot see, which this repo does not carry raw in a line it adds:
 * every format character (Cf) and every default-ignorable code point (zero-width
 * characters, direction marks, embeddings, overrides and isolates, joiners, invisible
 * operators, the byte order mark, the soft hyphen, the Hangul fillers, the variation
 * selectors, the tag characters), and the two Unicode line terminators U+2028 and
 * U+2029, which JavaScript ends a line on and git does not. The set is the engine's
 * own Unicode data; a test pins one code point of every range so a runtime with older
 * data cannot shrink it unnoticed.
 */
export const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;

/**
 * File extensions whose content is data. A file counts as binary only when its
 * extension is on this list AND its blob holds a NUL byte in the first 8000 bytes
 * (git's own test): its "lines" in a `--text` diff are bytes, which reach these ranges
 * by chance. Neither alone is enough: a NUL in a source file does not make it data,
 * and a file named `.png` without one is read as text.
 */
export const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'gz', 'tgz', 'zip', 'pdf', 'wasm', 'mp3', 'mp4', 'webm', 'ogg', 'wav', 'sqlite', 'db',
]);

/** Whether a file is data, by its extension and its bytes together (BINARY_EXTENSIONS). */
export function isBinaryFile(path, bytes) {
  const dot = path.lastIndexOf('.');
  const ext = dot > path.lastIndexOf('/') ? path.slice(dot + 1).toLowerCase() : '';
  return BINARY_EXTENSIONS.has(ext) && bytes.subarray(0, 8000).includes(0);
}

/** A code point as `U+XXXX`. */
const named = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** The escape that writes a code point in a JavaScript string. */
const escaped = (cp) => (cp > 0xffff ? `\\u{${cp.toString(16).toUpperCase()}}` : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`);

/** A path or text as it may be printed: every invisible character, NUL and carriage return as its escape. */
export function shown(text) {
  return text.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029\r\0]/gu, (c) => escaped(c.codePointAt(0)));
}

/**
 * A pictograph that is not also a letter or digit of a name: U+2139 is pictographic and
 * an identifier character, so a joiner between two of them would make a name that
 * reads the same as without it. The rule follows the Unicode property, not a list: a
 * pictograph that is NOT an identifier character passes, e.g. U+24C2 (circled M), since
 * a joiner next to it ends the name instead of hiding inside it. That is not a gap.
 */
const PICTOGRAPH = /^(?=\p{Extended_Pictographic})\P{ID_Continue}$/u;
const SKIN_TONE = /^[\u{1F3FB}-\u{1F3FF}]$/u;
/**
 * The tag sequences of the three subdivision flags Unicode recommends (England, Scotland,
 * Wales). Any other run of tag characters is text a reader cannot see and a model can.
 */
const FLAG_TAGS = ['gbeng', 'gbsct', 'gbwls'].map((code) => [...code].map((ch) => String.fromCodePoint(0xe0000 + ch.codePointAt(0))));
const KEYCAP_BASE = /^[0-9#*]$/;

/**
 * The positions of a line's code points that are part of an emoji and pass: a zero-width
 * joiner between two pictographs (after one, its skin tone or its U+FE0F), U+FE0F right
 * after a pictograph or before a keycap mark, and the tag characters of a complete flag
 * sequence of the three recommended subdivision flags (U+1F3F4, the tags, U+E007F). Checked per character, so a family
 * of three passes and two joiners in a row do not.
 */
export function emojiParts(points) {
  const ok = new Set();
  for (let i = 0; i < points.length; i++) {
    const cp = points[i];
    if (cp === '\u200D') {
      const before = points[i - 1];
      const after = points[i + 1];
      if (before !== undefined && after !== undefined && (PICTOGRAPH.test(before) || SKIN_TONE.test(before) || before === '\uFE0F') && PICTOGRAPH.test(after)) ok.add(i);
    } else if (cp === '\uFE0F') {
      const before = points[i - 1];
      if (before !== undefined && (PICTOGRAPH.test(before) || (KEYCAP_BASE.test(before) && points[i + 1] === '\u20E3'))) ok.add(i);
    } else if (cp === '\u{1F3F4}') {
      const tags = FLAG_TAGS.find((t) => t.every((ch, k) => points[i + 1 + k] === ch) && points[i + 1 + t.length] === '\u{E007F}');
      if (tags) for (let k = i + 1; k <= i + 1 + tags.length; k++) ok.add(k);
    }
  }
  return ok;
}

/**
 * The invisible characters in one line, each once as `U+XXXX`, in order of first
 * appearance: the INVISIBLE set outside emojiParts, a NUL byte, and a carriage return
 * anywhere but at the end of the line (a CRLF file keeps its line ends).
 */
export function formatCharsIn(line) {
  const points = [...line];
  const ok = emojiParts(points);
  const found = [];
  points.forEach((c, i) => {
    const cp = c.codePointAt(0);
    const hit = INVISIBLE.test(c) ? !ok.has(i) : cp === 0 || (c === '\r' && i < points.length - 1);
    if (hit && !found.includes(named(cp))) found.push(named(cp));
  });
  return found;
}

/** How to write a code point instead, for the message. */
export function wayFor(name) {
  const cp = parseInt(name.slice(2), 16);
  if (cp === 0) return 'a text file carries no NUL byte: write \\0 in a string (a text file saved as UTF-16 carries them too: save it as UTF-8)';
  if (cp === 0x0d) return 'write \\r in a string';
  if (cp === 0xad) return `write ${escaped(cp)} in a string, &shy; in markup`;
  return `write ${escaped(cp)}`;
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
        throw new Error(`unexpected line inside a hunk of ${shown(path ?? '')}`);
      }
      continue;
    }
    if (l.startsWith('@@@')) throw new Error(`a combined diff hunk in ${shown(path ?? '')}, which this check cannot read`);
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
/**
 * The paths each commit in base..head adds, copies or renames to, as { commit, path,
 * renamed }: a name is read for invisible characters too, also of a file that adds no
 * line. Read NUL-separated, so a name holding a line break or `commit <sha>` stays one
 * name.
 */
function pathsOf(base, head) {
  const out = [];
  let commit = null;
  const parts = git(['--no-replace-objects', '-c', 'core.quotePath=false', 'log', '-z', '--format=commit %H',
    '--name-status', '--diff-filter=ACR', '-M', '--diff-merges=remerge', '--no-relative', `${base}..${head}`]).split('\0');
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].replace(/^\n/, '');
    const c = token.match(/^commit ([0-9a-f]{40,64})$/);
    if (c) {
      commit = c[1];
      continue;
    }
    if (token === '' || commit === null) continue;
    if (/^[RC]\d*$/.test(token)) {
      out.push({ commit, path: parts[i + 2], renamed: token.startsWith('R') });
      i += 2;
    } else {
      out.push({ commit, path: parts[i + 1], renamed: false });
      i += 1;
    }
  }
  return out.filter((p) => p.path !== undefined);
}

/**
 * A renamed file shows only the lines its rename changed, so a file that was data under
 * its old name (and skipped) could become text with no line read. The target of every
 * rename that is text at its commit is therefore read in full for invisible characters.
 */
function blobOf(commit, path) {
  try {
    return execFileSync('git', ['--no-replace-objects', 'cat-file', 'blob', `${commit}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    // Not readable as a blob at that commit (a submodule, a path git cannot address): read as text, empty.
    return Buffer.alloc(0);
  }
}

/** The invisible characters in a file name: those of a line, and a line break anywhere in it. */
export function nameCharsIn(path) {
  const found = formatCharsIn(path);
  for (const [c, name] of [['\n', 'U+000A'], ['\r', 'U+000D']]) if (path.includes(c) && !found.includes(name)) found.push(name);
  return found;
}

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
  let pathsAdded;
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
    pathsAdded = pathsOf(base, head);
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
  let formats = 0;
  const binary = new Map();
  const isBinaryAt = (commit, path) => {
    const key = `${commit}\0${path}`;
    if (!binary.has(key)) {
      binary.set(key, isBinaryFile(path, blobOf(commit, path)));
    }
    return binary.get(key);
  };
  const report = (where, what) => {
    console.log(`${where}: ${what}`);
    total++;
  };
  const readWhole = new Set(pathsAdded.filter((p) => p.renamed && !isBinaryAt(p.commit, p.path)).map((p) => `${p.commit}\0${p.path}`));
  for (const a of added) {
    const where = `commit ${a.commit.slice(0, 9)} ${shown(a.path)}:${a.line}`;
    for (const kind of findingsIn(a.text)) report(where, kind);
    if (isBinaryAt(a.commit, a.path) || readWhole.has(`${a.commit}\0${a.path}`)) continue;
    for (const name of formatCharsIn(a.text)) {
      report(where, `raw invisible character ${name}, ${wayFor(name)}`);
      formats++;
    }
  }
  for (const { commit, path, renamed } of pathsAdded) {
    if (renamed && readWhole.has(`${commit}\0${path}`)) {
      blobOf(commit, path).toString('utf8').split('\n').forEach((line, i) => {
        for (const name of formatCharsIn(line)) {
          report(`commit ${commit.slice(0, 9)} ${shown(path)}:${i + 1}`, `raw invisible character ${name} in a renamed file, which is read in full, ${wayFor(name)}`);
          formats++;
        }
      });
    }
    for (const name of nameCharsIn(path)) {
      report(`commit ${commit.slice(0, 9)} ${shown(path)}`, `raw invisible character ${name} in the file name`);
      formats++;
    }
  }
  if (total > 0) {
    console.error(`\nadded-lines-guard: ${total} finding(s) in lines this range adds. This is the PUBLIC repo.`);
    console.error('Describe the behaviour instead of naming an internal id; describe the change, not an open finding.');
    if (formats > 0) {
      console.error('A raw invisible character: write its escape instead (\\u202E, not the character); in a');
      console.error('string it is the same value at runtime. The Edit and Write tools turn an escape into the raw');
      console.error('character, so write the line through a script or check it after the edit.');
    }
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
if (invoked !== null && fileURLToPath(import.meta.url) === invoked) process.exitCode = main(process.argv);
