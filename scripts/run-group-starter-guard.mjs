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
 * `runOutsideGroup` or carries the marker `run-group-starter: <reason>`. A comment line
 * is not a starter.
 *
 * A MOVE IS NOT NEW CODE. A line that the same change removes somewhere and adds again —
 * a file moved or renamed, a block moved, a line re-indented — was there before and is
 * not read as added. Lines are compared with surrounding whitespace trimmed, across the
 * whole change and every file, in and out of the four directories, counted one for one.
 *
 * WHAT IT DOES NOT SEE, stated rather than implied. This is a floor, not a proof:
 *   · a starter under another name: an alias (`const tick = setInterval`), a helper
 *     that starts a timer or a loop inside it, a library that does (a watcher, a queue
 *     package), `subscribe(` and other listener APIs not in the list;
 *   · a starter written across lines so that no added line carries the form;
 *   · a recursive chain (`.then(() => this.loop())`) or a cached promise that loops;
 *   · whether the starter is really started inside a run at all — every form is asked,
 *     and a marker says why it is fine;
 *   · a change that edits a line next to an existing unmarked starter;
 *   · code outside the four directories.
 *
 * Exit 0: checked and clean · 1: an unmarked starter, the locations are printed ·
 * 2: could not check (a ref that does not resolve, a diff that cannot be read, a range
 * that changes nothing, or the self-check below failing). 2 is not a pass.
 *
 * The self-check runs first, on every call: the matcher is fed one unmarked starter it
 * must flag and the same line moved, which it must not. A matcher that stopped matching
 * would otherwise pass every change, which looks exactly like a clean one.
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
  { name: '.finally(() => this.', re: /\.finally\s*\(\s*\(\s*\)\s*=>\s*this\./ },
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

/** The starter form a line carries, or null. */
export function starterIn(text) {
  if (isComment(text)) return null;
  for (const f of STARTER_FORMS) if (f.re.test(text)) return f.name;
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
 * Parse a unified diff with zero context into added lines (file, new line number, text)
 * and the multiset of removed lines (trimmed text → count).
 */
export function parseDiff(diff) {
  const added = [];
  const removed = new Map();
  let file = null;
  let newLine = 0;
  // Header lines (`--- a/…`, `+++ b/…`) are read only between `diff --git` and the first
  // hunk: inside a hunk, a removed line reading `-- x` is `--- x` and is content.
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { inHeader = true; file = null; continue; }
    if (inHeader) {
      if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ b\//, '');
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
  return { added, removed };
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

/** Positive control: a broken matcher must not look like a clean change. */
export function selfCheck() {
  const line = '  const timer = setInterval(() => { void tick(); }, 60_000);';
  const added = [{ file: 'src/core/self-check.ts', line: 1, text: line }];
  const flagged = findings(added, new Map(), () => [line]);
  const moved = findings(added, new Map([[line.trim(), 1]]), () => [line]);
  return flagged.length === 1 && moved.length === 0;
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
  try {
    git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    git(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
    // Whole change, every file, renames off: a moved file reads as removed + added, so
    // its lines are matched one for one like any other move.
    diff = git(['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U0', base, head]);
  } catch (err) {
    console.error(`run-group-starter-guard: COULD NOT CHECK — ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    return 2;
  }
  if (diff.trim() === '') {
    console.error(`run-group-starter-guard: COULD NOT CHECK — ${base}..${head} changes nothing; a range with no change is not a clean one.`);
    return 2;
  }
  const { added, removed } = parseDiff(diff);
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
