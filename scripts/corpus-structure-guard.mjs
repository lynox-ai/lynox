#!/usr/bin/env node
/**
 * corpus-structure-guard — refuses a file this change ADDS OR CHANGES when its content has the
 * shape of an eval corpus: an object carrying an array named `turns` or `gold`, at any depth. That is
 * the shape `tests/eval/knowledge-substrate-score.ts › loadCorpus` reads (threads of user
 * turns with the facts worth keeping), and a corpus generated from real threads must never
 * reach this PUBLIC repository: a commit cannot be taken back.
 *
 *   node scripts/corpus-structure-guard.mjs --staged
 *   node scripts/corpus-structure-guard.mjs <base> <head> [--allow-empty] [--no-paths]
 *
 * Three callers. The pre-commit hook (`--staged`) reads the files the commit adds or changes,
 * from the index. The pre-push hook reads every commit the push transfers (ranges from
 * `.lefthook/pre-push/pushed-ranges.sh`), also during a merge or rebase; of the three it is the
 * one that runs before publication, because a pushed commit is readable on the pull request
 * whatever CI says later. A push made with hooks switched off is not read by it. The CI step
 * in `.github/workflows/public-repo-guard.yml` reads every commit of the pull request and keeps
 * it from being MERGED; it passes `--no-paths`, so a public Actions log names no file.
 *
 * WHY CONTENT, NOT NAME. `.gitignore` keeps `*.jsonl`, `*.ndjson` and `*gold*.json` out, but a
 * name says nothing about what a file holds, and `loadCorpus` parses ANY path that does not
 * end in `.jsonl` as JSON. So every added or changed file is read, whatever it is called.
 *
 * WHY EVERY COMMIT. A file one commit adds and a later commit deletes is absent from the head
 * and still goes out with the push. The range mode reads what each commit itself adds or
 * changes, not the difference between base and head.
 *
 * WHAT IT READS, and what each case answers:
 *   · added, copied, renamed, CHANGED and type-changed files (a symlink replaced by a file):
 *     the diff runs with `--no-renames --diff-filter=AMT`, and the new content is read;
 *   · parsed as strict JSON, then as JSON with comments and trailing commas, then as one JSON
 *     value per line (the `.jsonl` form). The first that parses is searched;
 *   · UTF-16 (by its byte-order mark) is decoded first, a UTF-8 byte-order mark removed;
 *   · a file NAMED as JSON (`.json`, `.jsonc`, `.jsonl`, `.ndjson`, also with a suffix after
 *     it, `x.json.bak`) that is not text or does not parse is REFUSED: what cannot be read
 *     cannot be said to hold no thread content. An empty one passes, it holds nothing;
 *   · a file over 100 MiB (the size GitHub refuses anyway; see maxBytes) is REFUSED, not read;
 *   · a file under any other name that is not text, or whose text does not start with `{` or
 *     `[`, or does not parse, passes: `loadCorpus` reads a file with `JSON.parse`, so such a
 *     file is not a corpus it can load. That includes `.json5` with unquoted keys;
 *   · a symlink and a submodule entry pass, and the summary line counts them: the commit
 *     carries a link target or a commit id, not the content of the file behind it;
 *   · the keys `turns` and `gold` are matched without regard to case.
 *
 * WHAT IT DOES NOT READ, stated rather than implied: thread text in another shape (prose, a
 * different key name, a string holding encoded JSON, an archive), and content stored outside
 * the commit, such as a Git LFS object behind its pointer.
 *
 * A synthetic corpus that belongs in the repo is listed in ALLOWED by path AND the blob ids of its
 * reviewed contents, in this file, so the exception is a line a reviewer sees, and content that
 * was not reviewed is read again. The CI step reads this script from the pull request's BASE
 * commit, so a new id takes effect in CI only once it is on main: a pull request cannot list an
 * id and bring the content it allows together.
 *
 * Exit 0: checked and clean · 1: refused, the reasons are printed · 2: could not check (git
 * failed, a ref that does not resolve, no commits in the range without `--allow-empty`, or an
 * error while reading a file). 2 is not a pass; every caller fails on it like on 1.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Synthetic corpora that are meant to be tracked: path (relative to the repo root) → the git blob
 * ids of every content of it that was reviewed. Content whose id is not listed is read again.
 *
 * Ids are added, never replaced: a commit already in history keeps the content it was judged by.
 * Regenerating a listed corpus takes two pull requests, because CI reads this file from the base
 * commit: the first adds the new id here and nothing else, the second changes the corpus.
 */
export const ALLOWED = new Map([
  ['tests/eval/knowledge-substrate-fixtures.json', new Set([
    '284d10a2908c1d14982817813f4785d03df7b71c',
  ])],
]);

/** The id git gives a blob with this content (SHA-1 object format, which this repository uses). */
export function blobId(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** GitHub refuses a file over 100 MiB. An environment value may LOWER the limit (tests), never raise it. */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
export function maxBytes(env = process.env) {
  const v = Number(env['CORPUS_GUARD_MAX_BYTES']);
  return Number.isFinite(v) && v >= 0 && v < DEFAULT_MAX_BYTES ? v : DEFAULT_MAX_BYTES;
}

const JSON_NAMED = /\.(?:jsonc?|jsonl|ndjson)(?:\.|$)/iu;
const CORPUS_KEYS = new Set(['turns', 'gold']);

/** Text of a blob, or null when it is not text. */
export function decode(buf) {
  let b = buf;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) b = Buffer.from(b.subarray(2)).toString('utf16le');
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const le = Buffer.from(b.subarray(2));
    le.swap16();
    b = le.toString('utf16le');
  } else b = b.toString('utf8');
  if (b.charCodeAt(0) === 0xfeff) b = b.slice(1);
  return b.includes('\0') ? null : b;
}

/** Walk `text` outside of strings: `onChar(i)` returns how many characters it consumed and what to emit. */
function outsideStrings(text, onChar) {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      const [used, emit] = onChar(i);
      out += emit;
      i += used;
    }
  }
  return out;
}

/**
 * JSON with comments and trailing commas, reduced to strict JSON. Strings are left as they are.
 * Two passes, because a comment can stand between a trailing comma and its bracket.
 */
export function stripJsonc(text) {
  const noComments = outsideStrings(text, (i) => {
    if (text[i] === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      return [end === -1 ? text.length - i : end - i, ''];
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      return [end === -1 ? text.length - i : end + 2 - i, ' '];
    }
    return [1, text[i]];
  });
  return outsideStrings(noComments, (i) => {
    if (noComments[i] !== ',') return [1, noComments[i]];
    let j = i + 1;
    while (j < noComments.length && /\s/u.test(noComments[j])) j++;
    return [1, noComments[j] === '}' || noComments[j] === ']' ? '' : ','];
  });
}

/** The parsed values of a text, or null when no form parses. */
export function parseValues(text) {
  try { return [JSON.parse(text)]; } catch { /* next form */ }
  try { return [JSON.parse(stripJsonc(text))]; } catch { /* next form */ }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const values = [];
  for (const l of lines) {
    try { values.push(JSON.parse(l)); } catch { return null; }
  }
  return values;
}

/** The first corpus key found as an array inside an object, at any depth. Iterative: no depth limit. */
export function corpusKeyIn(values) {
  const stack = [...values];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    // One push per element: spreading a large array into push() overflows the call stack.
    if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
    for (const [k, child] of Object.entries(v)) {
      if (CORPUS_KEYS.has(k.toLowerCase()) && Array.isArray(child)) return k;
      stack.push(child);
    }
  }
  return null;
}

/**
 * The verdict on one file's content. `{ refuse: false, note }` or `{ refuse: true, reason }`,
 * where reason is 'corpus' | 'unreadable'. The size limit is applied before, in `run`, so a
 * file over it is never read.
 */
export function classify(path, buf) {
  const named = JSON_NAMED.test(path);
  const text = decode(buf);
  if (text === null) return named ? { refuse: true, reason: 'unreadable' } : { refuse: false, note: 'not text' };
  const body = text.trimStart();
  if (body === '') return { refuse: false, note: 'empty' };
  // A name that says JSON is always parsed (its text may start with a comment); any other name
  // only when its text starts like a JSON value — `loadCorpus` reads with `JSON.parse`.
  if (!named && !(body.startsWith('{') || body.startsWith('['))) return { refuse: false, note: 'not JSON' };
  const values = parseValues(body);
  if (values === null) return named ? { refuse: true, reason: 'unreadable' } : { refuse: false, note: 'not JSON' };
  const key = corpusKeyIn(values);
  if (key === null) return { refuse: false, note: 'JSON' };
  if (ALLOWED.get(path)?.has(blobId(buf))) return { refuse: false, note: 'allowed corpus' };
  return { refuse: true, reason: 'corpus', key };
}

const ADVICE = {
  corpus: 'carries an array named `turns` or `gold` inside an object: the shape of an eval corpus. '
    + 'A corpus built from real threads stays outside this repository. If this one is synthetic '
    + 'and its path is already listed in ALLOWED in scripts/corpus-structure-guard.mjs, add its '
    + 'blob id (`git hash-object <file>`) there in a pull request of its own; CI reads that list '
    + 'from main, so the file itself follows in a second one. A path that is not listed yet has '
    + 'no such route: listing it without the file fails this repository\'s own tests, and CI, which '
    + 'reads the list from main, refuses it together with the file until the list is there.',
  unreadable: 'is named as JSON but is not text that parses as JSON, JSON with comments, or one JSON '
    + 'value per line, so what it holds cannot be checked. Make it parse, or give it a name that '
    + 'does not say JSON if it is not JSON.',
  'too-large': 'is larger than 100 MiB and is not read. GitHub refuses such a file anyway; keep it '
    + 'outside the repository.',
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `git diff --raw -z` output → [{ mode, oid, path }] for the files it lists. */
export function parseRaw(buf) {
  const parts = buf.toString('utf8').split('\0');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].trim();
    if (!meta.startsWith(':')) continue;
    const [, newMode, , newOid] = meta.slice(1).split(/\s+/u);
    out.push({ mode: newMode, oid: newOid, path: parts[i + 1] });
  }
  return out;
}

const RAW = ['--raw', '-z', '--no-abbrev', '--no-renames', '--diff-filter=AMT', '-r'];

function stagedAdditions(cwd) {
  return [{ label: 'the staged commit', files: parseRaw(git(['diff', '--cached', ...RAW], cwd)) }];
}

function rangeAdditions(base, head, cwd) {
  const commits = git(['rev-list', '--reverse', `${base}..${head}`], cwd).toString('utf8').split('\n').filter(Boolean);
  return commits.map((c) => {
    const parents = git(['rev-list', '--parents', '-n', '1', c], cwd).toString('utf8').trim().split(' ').slice(1);
    const args = parents.length === 0 ? ['diff-tree', '--root', ...RAW, c] : ['diff-tree', ...RAW, parents[0], c];
    return { label: `commit ${c.slice(0, 10)}`, files: parseRaw(git(args, cwd)) };
  });
}

export function run(argv, { cwd = process.cwd(), env = process.env, log = console.log, err = console.error } = {}) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const refs = argv.filter((a) => !a.startsWith('--'));
  const noPaths = flags.has('--no-paths');
  let groups;
  try {
    if (flags.has('--staged')) groups = stagedAdditions(cwd);
    else if (refs.length === 2) groups = rangeAdditions(refs[0], refs[1], cwd);
    else {
      err('usage: corpus-structure-guard.mjs --staged | <base> <head> [--allow-empty] [--no-paths]');
      return 2;
    }
  } catch (e) {
    err(`corpus-structure-guard: could not read what this change adds — ${String(e.stderr ?? e.message ?? e).trim()}`);
    return 2;
  }
  if (!flags.has('--staged') && groups.length === 0 && !flags.has('--allow-empty')) {
    err('corpus-structure-guard: the range holds no commits, so nothing was checked.');
    return 2;
  }

  const limit = maxBytes(env);
  const refused = [];
  let read = 0, links = 0, submodules = 0;
  try {
    for (const g of groups) {
      g.files.forEach((f, i) => {
        if (f.mode === '120000') { links++; return; }
        if (f.mode === '160000') { submodules++; return; }
        // The size first, so a file over the limit is refused without being read into memory.
        const size = Number(git(['cat-file', '-s', f.oid], cwd).toString('utf8').trim());
        const verdict = size > limit
          ? { refuse: true, reason: 'too-large' }
          : classify(f.path, git(['cat-file', 'blob', f.oid], cwd));
        read++;
        if (verdict.refuse) refused.push({ where: noPaths ? `file ${i + 1} in ${g.label}` : `${f.path} (${g.label})`, reason: verdict.reason });
      });
    }
  } catch (e) {
    err(`corpus-structure-guard: could not read an added or changed file — ${String(e.stderr ?? e.message ?? e).trim()}`);
    return 2;
  }

  const notRead = links + submodules > 0
    ? `; not read: ${links} symlink(s), ${submodules} submodule entr(y/ies) — the commit carries a link or a commit id, not file content`
    : '';
  if (refused.length === 0) {
    log(`corpus-structure-guard: clean — ${read} added or changed file(s) read across ${groups.length} commit(s)${notRead}.`);
    return 0;
  }
  err(`corpus-structure-guard: ${refused.length} added or changed file(s) refused${notRead}.`);
  for (const r of refused) err(`  ✗ ${r.where} ${ADVICE[r.reason]}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(run(process.argv.slice(2)));
}
