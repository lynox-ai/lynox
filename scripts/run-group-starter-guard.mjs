#!/usr/bin/env node
/**
 * run-group-starter-guard — every line a change ADDS to the engine's source that starts
 * something long-lived must say how it stands to the run group.
 *
 *   node scripts/run-group-starter-guard.mjs <base-ref> <head-ref>
 *
 * WHY. The run group (`src/core/run-group.ts`) lives in AsyncLocalStorage, and an async
 * resource takes the context that is current when it is CREATED. An interval, a polling
 * loop, a listener on a long-lived emitter or a queue that starts its next job from the
 * last one's callback — first started inside a run — reports every later spend in that
 * run's group, for good. The fix is `runOutsideGroup` where it starts (or per job), and
 * nothing in the code itself makes anyone think of it. This check makes the question
 * come up at the line that creates such a thing.
 *
 * WHAT IS CHECKED. Added lines in `src/core`, `src/tools`, `src/orchestrator` and
 * `src/integrations` (tests excluded) that carry a starter form (see STARTER_FORMS). Such
 * a line passes when it, or one of the three lines above it in the new file, names
 * `runOutsideGroup` or carries the marker `run-group-starter: <reason>`. Naming is
 * enough: an import or a closed `runOutsideGroup(…)` call on the line above counts too,
 * the check does not see whether the starter is INSIDE the call. A comment line is not a
 * starter; a leading closed `/* … *\/` is stripped and the rest of the line is judged.
 *
 * A MOVE IS NOT NEW CODE. A line that the same change removes somewhere and adds again —
 * a file moved or renamed, a block moved, a line re-indented — was there before and is
 * not read as added. Lines are compared with surrounding whitespace trimmed, across the
 * whole change and every file, in and out of the four directories, counted one for one.
 * The price: a removed line launders an identical added one wherever it came from (a
 * test, a file outside the four directories), and a starter MOVED from boot code into
 * code that runs inside a run passes as a move — though where it sits is what decides
 * whether it carries a group.
 *
 * WHAT IT DOES NOT SEE, stated rather than implied. This is a floor, not a proof:
 *   · a starter under another name: an alias (`const tick = setInterval`), a helper
 *     that starts a timer or a loop inside it, a library that does (a watcher, a queue
 *     package), `subscribe(` and other listener APIs not in the list;
 *   · a loop on a condition that is not a literal (`while (!this.stopped)`, `do … while`);
 *   · a starter written across lines so that no added line carries the form;
 *   · a recursive chain (`.then(() => this.loop())`) or a cached promise that loops;
 *   · whether the starter is really started inside a run at all — every form is asked,
 *     and a marker says why it is fine (a synchronous `for (;;)` or a cleared timeout is
 *     asked too, and answered with a marker);
 *   · a change that edits a line next to an existing unmarked starter;
 *   · code after the end of a multi-line comment on the same line (`*\/ setInterval(…)`);
 *   · code outside the four directories, and in them anything but ts/mts/cts/js/mjs/cjs
 *     files or anything under `fixtures/`, `__mocks__/` or `__tests__/`.
 *
 * A path git has to quote (a TAB, `"`, `\` or a newline in the name) cannot be read and
 * always ends in 2: such a file in the four directories cannot merge until it is renamed.
 *
 * Exit 0: checked and clean · 1: an unmarked starter, the locations are printed ·
 * 2: could not check (a ref that does not resolve, a diff that cannot be read, a range
 * that changes nothing, an in-scope file whose added lines the parser did not read as
 * git counts them, or the self-check below failing). 2 is not a pass.
 *
 * The self-check runs first, on every call: a diff that adds one unmarked starter goes
 * through the parser and the matcher and must be flagged; a diff that removes the same
 * line from another file and adds it must not. A matcher or parser that stopped working
 * would otherwise pass every change, which looks exactly like a clean one. The count
 * comparison below catches a parse that missed a file's lines. Each form against a sample,
 * paths, git's flags and the comparison itself are the test suite's job, on the copy the
 * step will later read from main.
 *
 * No imports beyond node built-ins, so the workflow can run the copy from the pull
 * request's BASE commit on its own.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MARKER = 'run-group-starter:';
export const SCOPE = ['src/core/', 'src/tools/', 'src/orchestrator/', 'src/integrations/'];
const LOOKBACK = 3;

/** Forms that create something which can outlive the code that created it. */
export const STARTER_FORMS = [
  { name: 'setInterval', re: /\bsetInterval\s*\(/ },
  { name: 'setTimeout', re: /\bsetTimeout\s*\(/ },
  { name: 'setImmediate', re: /\bsetImmediate\s*\(/ },
  { name: 'process.nextTick', re: /\bprocess\.nextTick\s*\(/ },
  { name: 'queueMicrotask', re: /\bqueueMicrotask\s*\(/ },
  { name: 'for (;;)', re: /\bfor\s*\(\s*;\s*;\s*\)/ },
  { name: 'while (true)', re: /\bwhile\s*\(\s*true\s*\)/ },
  { name: 'for await', re: /\bfor\s+await\s*\(/ },
  { name: 'listener', re: /\.(?:on|once|addListener|prependListener|addEventListener)\s*\(/ },
  // A queue that starts its next job from the last one's `.finally` — the block-body form
  // `.finally(() => {` is how real code writes it, so every `.finally(` is asked.
  { name: '.finally(', re: /\.finally\s*\(/ },
];

/** The file is in scope: one of the four directories, a source file, not a test. */
export function inScope(path) {
  if (!SCOPE.some((d) => path.startsWith(d))) return false;
  if (!/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(path)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(path)) return false;
  if (/(?:^|\/)(?:__tests__|__mocks__|fixtures)\//.test(path)) return false;
  return true;
}

const isComment = (text) => /^\s*(?:\/\/|\/\*|\*)/.test(text);

/** The starter form a line carries, or null. A closed leading `/* … *\/` is not a comment line. */
export function starterIn(text) {
  const code = text.replace(/^\s*(?:\/\*.*?\*\/\s*)+/, '');
  if (code === '' || isComment(code)) return null;
  for (const f of STARTER_FORMS) if (f.re.test(code)) return f.name;
  return null;
}

/** The line, or one of the LOOKBACK lines above it, says how it stands to the group. */
export function isMarked(fileLines, index) {
  for (let i = index; i >= Math.max(0, index - LOOKBACK); i--) {
    const t = fileLines[i] ?? '';
    if (t.includes('runOutsideGroup')) return true;
    const m = t.indexOf(MARKER);
    if (m !== -1 && t.slice(m + MARKER.length).trim().length >= 3) return true;
  }
  return false;
}

/**
 * Parse a unified diff with zero context into added lines (file, new line number, text),
 * the multiset of removed lines (trimmed text → count), and the paths read from file
 * headers (`seen`).
 */
export function parseDiff(diff) {
  const added = [];
  const removed = new Map();
  const seen = new Set();
  let file = null;
  let newLine = 0;
  // Header lines (`--- a/…`, `+++ b/…`) are read only between `diff --git` and the first
  // hunk: inside a hunk, a removed line reading `-- x` is `--- x` and is content.
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { inHeader = true; file = null; continue; }
    if (inHeader) {
      // A path with a space ends in a TAB; a path git has to quote keeps its quotes and is
      // then out of scope here — `countsMatch` below turns that into "could not check".
      if (line.startsWith('--- a/')) seen.add(line.slice('--- a/'.length).replace(/\t$/, ''));
      if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ b\//, '').replace(/\t$/, '');
      if (file !== null) seen.add(file);
      const first = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (first) { inHeader = false; newLine = Number(first[1]); }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { newLine = Number(hunk[1]); continue; }
    if (line.startsWith('+')) {
      if (file !== null) added.push({ file, line: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      const key = line.slice(1).trim();
      removed.set(key, (removed.get(key) ?? 0) + 1);
    }
  }
  return { added, removed, seen };
}

/**
 * The unmarked starters among the added lines. `readFile(path)` returns the file's lines
 * at the head. A starter that the change also removes (a move) is consumed from the
 * removed multiset and not reported.
 */
export function findings(added, removed, readFile) {
  const pool = new Map(removed);
  const out = [];
  for (const a of added) {
    if (!inScope(a.file)) continue;
    const form = starterIn(a.text);
    if (form === null) continue;
    const key = a.text.trim();
    const left = pool.get(key) ?? 0;
    if (left > 0) { pool.set(key, left - 1); continue; }
    if (isMarked(readFile(a.file), a.line - 1)) continue;
    out.push({ file: a.file, line: a.line, form });
  }
  return out;
}

/**
 * The parse path read every added line git counted: for each in-scope file, the lines
 * `parseDiff` saw added equal the count `git diff --numstat -z` reports for it. A path the
 * parser could not read (quoted, re-prefixed) or a file git showed no hunk for would
 * otherwise look exactly like a clean file. `seen` are the paths the parser read from file
 * headers.
 */
export function countsMatch(added, numstat, seen = new Set()) {
  const parsed = new Map();
  for (const a of added) parsed.set(a.file, (parsed.get(a.file) ?? 0) + 1);
  const off = [];
  for (const [path, n] of numstat) {
    if (!inScope(path)) continue;
    const read = parsed.get(path) ?? 0;
    // null: git did not count (a file it treats as binary, `-diff` included — numstat
    // ignores `--text`). The diff, which honours `--text`, shows all of its lines; what
    // can go wrong is a path the parser could not read, so its header must have been read.
    // (Not "some line read": deleting or shrinking such a file adds none.)
    if (n === null ? !seen.has(path) : read !== n) off.push(`${path}: git counts ${n ?? 'binary'} added, read ${read}`);
  }
  return off;
}

/** `git diff --numstat -z` output → path → added lines, null where git counts none (`-`). */
export function parseNumstat(raw) {
  const out = new Map();
  for (const rec of raw.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
    if (m) out.set(m[3], m[1] === '-' ? null : Number(m[1]));
  }
  return out;
}

/** Positive control: a broken matcher or parser must not look like a clean change. */
export function selfCheck() {
  const line = '  const timer = setInterval(() => { void tick(); }, 60_000);';
  const add = ['diff --git a/src/core/self-check.ts b/src/core/self-check.ts', '--- /dev/null', '+++ b/src/core/self-check.ts', '@@ -0,0 +1 @@', `+${line}`];
  const remove = ['diff --git a/src/tools/old.ts b/src/tools/old.ts', '--- a/src/tools/old.ts', '+++ /dev/null', '@@ -1 +0,0 @@', `-    ${line.trim()}`];
  const flagged = parseDiff(add.join('\n'));
  const moved = parseDiff([...remove, ...add].join('\n'));
  return findings(flagged.added, flagged.removed, () => [line]).length === 1
    && findings(moved.added, moved.removed, () => [line]).length === 0;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** `check` is the self-check; a parameter only so a test can show a failing one stops the scan. */
export function main(argv, check = selfCheck) {
  const [base, head] = argv;
  if (!base || !head) {
    console.error('usage: run-group-starter-guard.mjs <base-ref> <head-ref>');
    return 2;
  }
  if (!check()) {
    console.error('run-group-starter-guard: COULD NOT CHECK — the self-check failed: the matcher no longer flags an unmarked setInterval, or flags a moved one.');
    return 2;
  }
  let diff;
  let numstat;
  try {
    git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    git(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
    // Whole change, every file, renames off: a moved file reads as removed + added, so
    // its lines are matched one for one like any other move. `--text --no-textconv`: a
    // `.gitattributes` the change adds (`-diff`) must not hide a file's lines; fixed
    // prefixes and quotePath=false: local diff config must not change the paths read.
    const opts = ['--no-color', '--no-ext-diff', '--no-renames', '--text', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];
    diff = git(['-c', 'core.quotePath=false', 'diff', ...opts, '-U0', base, head]);
    // -U0 here too: the context size changes how git aligns lines, and with it the counts
    // (a main commit read 210 added at -U0 and 211 at the default).
    numstat = parseNumstat(git(['diff', ...opts, '-U0', '--numstat', '-z', base, head]));
  } catch (err) {
    console.error(`run-group-starter-guard: COULD NOT CHECK — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return 2;
  }
  if (diff.trim() === '') {
    console.error(`run-group-starter-guard: COULD NOT CHECK — ${base}..${head} changes nothing; a range with no change is not a clean one.`);
    return 2;
  }
  const { added, removed, seen } = parseDiff(diff);
  const off = countsMatch(added, numstat, seen);
  if (off.length > 0) {
    console.error(`run-group-starter-guard: COULD NOT CHECK — the diff did not read as git counts it:\n  ${off.join('\n  ')}`);
    return 2;
  }
  const cache = new Map();
  const readFile = (path) => {
    if (!cache.has(path)) cache.set(path, git(['show', `${head}:${path}`]).split('\n'));
    return cache.get(path);
  };
  let found;
  try {
    found = findings(added, removed, readFile);
  } catch (err) {
    console.error(`run-group-starter-guard: COULD NOT CHECK — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return 2;
  }
  const scoped = added.filter((a) => inScope(a.file)).length;
  if (found.length === 0) {
    console.log(`run-group-starter-guard: clean — ${scoped} added line(s) in scope, self-check passed.`);
    return 0;
  }
  console.error(`run-group-starter-guard: ${found.length} added starter(s) without a word on the run group:`);
  for (const f of found) console.error(`  ${f.file}:${f.line}: ${f.form}`);
  console.error(
    'A long-lived thing first started inside a run keeps that run\'s group for every later spend (src/core/run-group.ts).\n' +
    `Start it under runOutsideGroup, or, when it cannot outlive the run or never reports spend, say so on the line or within ${LOOKBACK} lines above:\n` +
    `  // ${MARKER} <why this does not carry a run's group>`,
  );
  return 1;
}

const self = (() => { try { return realpathSync(fileURLToPath(import.meta.url)); } catch { return ''; } })();
const invoked = (() => { try { return process.argv[1] ? realpathSync(process.argv[1]) : ''; } catch { return ''; } })();
if (self !== '' && self === invoked) process.exit(main(process.argv.slice(2)));
