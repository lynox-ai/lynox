/**
 * Proof that a bash command is harmless enough to run unattended.
 *
 * The permission guard decides autonomous bash calls with a deny list: what it
 * does not recognise as dangerous runs. This module turns the direction around.
 * A command is PROVEN only when a small positive grammar generates all of it:
 *
 * - every byte outside single quotes is printable ASCII or a tab, and only the
 *   characters a plain word needs (letters, digits, `-_./=,:@%+`) appear there;
 * - commands are separated by `|`, `&&` or `;` and nothing else, and none is empty;
 * - each command starts with a program from {@link PROGRAMS}, named bare (no path,
 *   no assignment in front, no `cd`);
 * - every option is in that program's closed option set, matched the way GNU
 *   getopt reads it (bundled short options, attached values, exact long names,
 *   `--` ends options);
 * - every path the command names resolves, through symlinks, inside the working
 *   directory or an enumerated read root, and is not a sensitive file.
 *
 * Anything else is "not proven". That is not a verdict of danger, only the
 * absence of a proof. Double quotes, `$`, backticks, globs, braces, redirections
 * other than a trailing `2>/dev/null`, `~name` and every other shell feature fall
 * outside the grammar by construction, so a new spelling of an old trick lands on
 * the safe side without a rule for it.
 *
 * The module is pure apart from reading the file system to resolve paths; the
 * caller hands in the directories and the sensitive-path test.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** Event type of the observe-mode record in the local security log. */
export const BASH_OBSERVE_EVENT = 'bash_autonomy_observe';

/** Longer commands are not proven. Keeps the proof bounded and the window question moot. */
export const MAX_PROVEN_LENGTH = 4096;

/** More commands than this in one call are not proven: each is a process. */
export const MAX_PROVEN_COMMANDS = 16;

export type ProofReason =
  | 'ok'
  | 'length'
  | 'byte'
  | 'char'
  | 'quote'
  | 'tilde'
  | 'separator'
  | 'redirect'
  | 'program'
  | 'option'
  | 'value'
  | 'operand'
  | 'no-home'
  | 'root'
  | 'path-outside'
  | 'path-sensitive'
  | 'path-special'
  | 'path-unresolvable';

export interface BashProof {
  proven: boolean;
  reason: ProofReason;
  /** The program of the first command, or of the first command that failed — only
   *  when it is on {@link PROGRAMS}; `other` otherwise. Never a free-form name. */
  program: string;
}

export interface ProofEnv {
  /** Directory the command runs in (the bash tool's `cwd`). */
  cwd: string;
  /** HOME the shell expands `~` from. Without it a `~` path is not proven. */
  home: string | undefined;
  /** Directories, besides `cwd`, whose contents may be read. */
  readRoots: readonly string[];
  /** True when a resolved path is a sensitive file (credentials, keys, lynox stores). */
  isSensitive: (realPath: string) => boolean;
}

type ValueKind = 'number' | 'text' | 'path';
type OperandKind = 'paths' | 'text' | 'none' | 'grep' | 'date' | 'one-path';

interface ProgramSpec {
  /** Short option letter → the kind of value it takes, or null for a flag. */
  short: Readonly<Record<string, ValueKind | null>>;
  /** Exact long option name (without `--`) → value kind, or null for a flag. */
  long: Readonly<Record<string, ValueKind | null>>;
  operands: OperandKind;
  /** Upper bound on operands, where the program reads a later operand as an output. */
  maxOperands?: number;
  /** The program reads an operand starting with `+` as an option. */
  plusIsOption?: true;
}

const flags = (letters: string): Record<string, null> =>
  Object.fromEntries([...letters].map((c) => [c, null]));
const longFlags = (names: string): Record<string, null> =>
  Object.fromEntries(names.split(' ').map((n) => [n, null]));

/**
 * The programs that can be proven, each with a closed option set. Left out on
 * purpose, because an option or the program itself executes, writes or recurses:
 * `find` (`-exec`, `-fprint`), `rg` (`--pre`), `jq` (`env`, `input`), `git`
 * (config and environment start programs), `du` (always recurses), `file`
 * (decompressors, `-C` writes), `sort` (temporary files under `$TMPDIR`, which the
 * tool does not pin yet), `df` (reports every mount, and waits on one that hangs). For the ones listed, the same reasoning removed `tail
 * -f`, `grep -r`/`-f`/`--include`, `ls -R`, `stat --printf`, `date -s`, `uniq`'s
 * output operand and every option not named here.
 */
export const PROGRAMS: Readonly<Record<string, ProgramSpec>> = {
  cat: {
    short: flags('AbeEnstTuv'),
    long: longFlags('show-all number-nonblank show-ends number squeeze-blank show-tabs show-nonprinting'),
    operands: 'paths',
  },
  head: {
    short: { ...flags('qvz'), c: 'number', n: 'number' },
    long: { ...longFlags('quiet silent verbose zero-terminated'), bytes: 'number', lines: 'number' },
    operands: 'paths',
  },
  tail: {
    short: { ...flags('qvz'), c: 'number', n: 'number' },
    long: { ...longFlags('quiet silent verbose zero-terminated'), bytes: 'number', lines: 'number' },
    operands: 'paths',
    // GNU tail still reads `+NUM[bcl][f]` as an obsolete option, `f` included.
    plusIsOption: true,
  },
  wc: {
    short: flags('cmlwL'),
    long: longFlags('bytes chars lines words max-line-length'),
    operands: 'paths',
  },
  ls: {
    short: flags('aAlh1tSrdFpisngoGcuUXvNQB'),
    long: longFlags('all almost-all human-readable reverse directory size inode numeric-uid-gid no-group literal quote-name ignore-backups'),
    operands: 'paths',
  },
  grep: {
    short: { ...flags('ivnclLowxEFGPhHsqabzUTZ'), m: 'number', A: 'number', B: 'number', C: 'number', e: 'text' },
    long: {
      ...longFlags('ignore-case no-ignore-case invert-match line-number count files-with-matches files-without-match only-matching word-regexp line-regexp extended-regexp fixed-strings basic-regexp perl-regexp no-filename with-filename no-messages quiet silent text byte-offset null-data null initial-tab binary'),
      'max-count': 'number', 'after-context': 'number', 'before-context': 'number', context: 'number', regexp: 'text',
    },
    operands: 'grep',
  },
  cut: {
    short: { ...flags('snz'), b: 'text', c: 'text', f: 'text', d: 'text' },
    long: { ...longFlags('only-delimited zero-terminated complement'), bytes: 'text', characters: 'text', fields: 'text', delimiter: 'text', 'output-delimiter': 'text' },
    operands: 'paths',
  },
  tr: {
    short: flags('cCdst'),
    long: longFlags('complement delete squeeze-repeats truncate-set1'),
    operands: 'text',
    maxOperands: 2,
  },
  uniq: {
    short: { ...flags('cduiz'), f: 'number', s: 'number', w: 'number' },
    long: { ...longFlags('count repeated unique ignore-case zero-terminated'), 'skip-fields': 'number', 'skip-chars': 'number', 'check-chars': 'number' },
    operands: 'one-path',
  },
  pwd: { short: flags('LP'), long: {}, operands: 'none' },
  stat: { short: flags('Lt'), long: longFlags('dereference terse'), operands: 'paths' },
  date: { short: flags('u'), long: longFlags('utc universal'), operands: 'date' },
  // `echo` is handled on its own: dash's echo knows only `-n`, and any other word is text.
  echo: { short: {}, long: {}, operands: 'text' },
};

interface Word {
  text: string;
  /** Some part of the word was single-quoted. */
  quoted: boolean;
  /** The word starts with an unquoted `~` that the shell will expand. */
  tilde: boolean;
}

type Segment = { words: Word[] };

class NotProven {
  constructor(readonly reason: ProofReason) {}
}

const WORD_CHAR = /[A-Za-z0-9\-_./=,:@%+]/;
const NUMBER = /^[+-]?\d{1,12}(?:[bkKMGTPEZY]|[KMGTPEZY]i?B|kB)?$/;
const REDIRECT = '2>/dev/null';

/** Split into commands of words, or throw {@link NotProven}. One linear pass. */
function lex(cmd: string): Segment[] {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let word: Word | null = null;
  let redirected = false;

  const endWord = (): void => {
    if (word) {
      if (redirected) throw new NotProven('redirect');
      words.push(word);
      word = null;
    }
  };
  const endSegment = (): void => {
    endWord();
    if (words.length === 0) throw new NotProven('separator');
    segments.push({ words });
    words = [];
    redirected = false;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const code = c.charCodeAt(0);
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close === -1) throw new NotProven('quote');
      const body = cmd.slice(i + 1, close);
      for (let j = 0; j < body.length; j++) {
        const b = body.charCodeAt(j);
        // Inside single quotes everything is literal, but control bytes are not proven.
        if (b < 0x20 || b === 0x7f) throw new NotProven('byte');
      }
      word ??= { text: '', quoted: false, tilde: false };
      word.text += body;
      word.quoted = true;
      i = close;
      continue;
    }
    if (code < 0x20 || code > 0x7e) throw new NotProven('byte');
    // `||`, `;;` and `|&` need no rule of their own: the second character ends an
    // empty command, or is a lone `&`, and both are refused.
    if (c === '|') {
      endSegment();
      continue;
    }
    if (c === '&') {
      if (cmd[i + 1] !== '&') throw new NotProven('separator');
      endSegment();
      i++;
      continue;
    }
    if (c === ';') {
      endSegment();
      continue;
    }
    if (c === '>') {
      // Only `2>/dev/null` as a word of its own, and only as the last word of a command:
      // anything that follows it in the same command starts a word, which is refused.
      const w = word as Word | null;
      const rest = cmd.slice(i + 1, i + 1 + REDIRECT.length - 2);
      if (w && w.text === '2' && !w.quoted && !w.tilde && rest === '/dev/null' && !redirected) {
        word = null;
        redirected = true;
        i += REDIRECT.length - 2;
        continue;
      }
      throw new NotProven('redirect');
    }
    if (c === '~') {
      const next = cmd[i + 1];
      const atEnd = next === undefined || next === ' ' || next === '\t' || next === '/' || next === '|' || next === '&' || next === ';';
      if (word || !atEnd) throw new NotProven('tilde');
      word = { text: '~', quoted: false, tilde: true };
      continue;
    }
    if (!WORD_CHAR.test(c)) throw new NotProven('char');
    word ??= { text: '', quoted: false, tilde: false };
    word.text += c;
  }
  endSegment();
  return segments;
}

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** realpath, or for a path that does not exist, the real path of its longest existing ancestor plus the rest. */
function realPathOf(p: string): string {
  let ancestor = p;
  let tail = '';
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new NotProven('path-unresolvable');
    tail = tail ? join(basename(ancestor), tail) : basename(ancestor);
    ancestor = parent;
  }
  const real = realpathSync(ancestor);
  return tail ? join(real, tail) : real;
}

interface Roots {
  cwd: string;
  read: string[];
  home: string | undefined;
  /** False when the working directory is too wide to prove any path from. */
  pathsAllowed: boolean;
}

function provePath(word: Word, env: ProofEnv, roots: Roots): void {
  let text = word.text;
  if (text === '-') return; // stdin (the shell removes quotes, so `'-'` is stdin too)
  if (!roots.pathsAllowed) throw new NotProven('root');
  if (word.tilde) {
    if (!roots.home) throw new NotProven('no-home');
    text = roots.home + text.slice(1);
  }
  // No `..` at all. Path text drops `l/..` as a pair, the kernel resolves it as the parent
  // of whatever `l` points to, so behind a symlink the two disagree. Without `..`, the text
  // and the kernel only differ by `.` and repeated slashes, which mean the same to both.
  if (text.split('/').includes('..')) throw new NotProven('path-outside');
  const lexical = resolve(roots.cwd, text);
  // Outside already as text: refused without touching the file system, so a path the
  // model names cannot make the engine wait on a slow mount just to be told no.
  if (!within(lexical, roots.cwd) && !roots.read.some((r) => within(lexical, r))) {
    throw new NotProven('path-outside');
  }
  let real: string;
  try {
    real = realPathOf(lexical);
  } catch (err) {
    if (err instanceof NotProven) throw err;
    throw new NotProven('path-unresolvable');
  }
  // Again on the real path: a symlink inside the directory may point anywhere.
  if (!within(real, roots.cwd) && !roots.read.some((r) => within(real, r))) {
    throw new NotProven('path-outside');
  }
  if (env.isSensitive(real)) throw new NotProven('path-sensitive');
  if (existsSync(real)) {
    let st;
    try { st = lstatSync(real); } catch { throw new NotProven('path-unresolvable'); }
    if (!st.isFile() && !st.isDirectory()) throw new NotProven('path-special');
  }
}

function checkValue(kind: ValueKind, value: Word, env: ProofEnv, roots: Roots): void {
  if (kind === 'number') {
    if (value.tilde || !NUMBER.test(value.text)) throw new NotProven('value');
  } else if (kind === 'path') {
    provePath(value, env, roots);
  } else if (value.tilde) {
    // A text value the shell would expand is not the text the grammar saw.
    throw new NotProven('tilde');
  }
}

function proveSegment(seg: Segment, env: ProofEnv, roots: Roots): void {
  const [head, ...args] = seg.words;
  const name = head!.text;
  const spec = Object.hasOwn(PROGRAMS, name) ? PROGRAMS[name] : undefined;
  if (!spec || head!.quoted || head!.tilde) throw new NotProven('program');

  if (name === 'echo') {
    args.forEach((w, i) => {
      if (w.tilde) throw new NotProven('tilde');
      if (w.text.startsWith('-') && !(i === 0 && w.text === '-n')) throw new NotProven('option');
    });
    return;
  }

  const operands: Word[] = [];
  let patternGiven = false;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    const t = w.text;
    if (endOfOptions || w.tilde || t === '-' || !t.startsWith('-')) {
      operands.push(w);
      continue;
    }
    if (t === '--') { endOfOptions = true; continue; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const optName = eq === -1 ? t.slice(2) : t.slice(2, eq);
      if (!Object.hasOwn(spec.long, optName)) throw new NotProven('option');
      const kind = spec.long[optName]!;
      if (kind === null) {
        if (eq !== -1) throw new NotProven('option');
        continue;
      }
      let value: Word;
      if (eq !== -1) {
        value = { text: t.slice(eq + 1), quoted: w.quoted, tilde: false };
      } else {
        const next = args[++i];
        if (!next) throw new NotProven('option');
        value = next;
      }
      checkValue(kind, value, env, roots);
      if (optName === 'regexp') patternGiven = true;
      continue;
    }
    // Short options. An obsolete count form such as `tail -5f` (which is `tail -f`) fails
    // here too: no digit is an option of a program that counts.
    for (let j = 1; j < t.length; j++) {
      const letter = t[j]!;
      if (!Object.hasOwn(spec.short, letter)) throw new NotProven('option');
      const kind = spec.short[letter]!;
      if (kind === null) continue;
      let value: Word;
      if (j + 1 < t.length) {
        value = { text: t.slice(j + 1), quoted: w.quoted, tilde: false };
      } else {
        const next = args[++i];
        if (!next) throw new NotProven('option');
        value = next;
      }
      checkValue(kind, value, env, roots);
      if (letter === 'e') patternGiven = true;
      break;
    }
  }

  if (spec.maxOperands !== undefined && operands.length > spec.maxOperands) throw new NotProven('operand');
  if (spec.plusIsOption && operands.some((w) => w.text.startsWith('+'))) throw new NotProven('operand');
  switch (spec.operands) {
    case 'none':
      if (operands.length > 0) throw new NotProven('operand');
      return;
    case 'text':
      if (operands.some((w) => w.tilde)) throw new NotProven('tilde');
      return;
    case 'date':
      if (operands.length > 1 || (operands.length === 1 && (!operands[0]!.text.startsWith('+') || operands[0]!.tilde))) {
        throw new NotProven('operand');
      }
      return;
    case 'one-path':
      if (operands.length > 1) throw new NotProven('operand');
      operands.forEach((w) => provePath(w, env, roots));
      return;
    case 'grep': {
      const files = patternGiven ? operands : operands.slice(1);
      if (!patternGiven && operands.length === 0) throw new NotProven('operand');
      if (!patternGiven && operands[0]!.tilde) throw new NotProven('tilde');
      files.forEach((w) => provePath(w, env, roots));
      return;
    }
    case 'paths':
      // `ls` without an operand lists the working directory, so it needs the same proof.
      if (operands.length === 0 && name === 'ls') provePath({ text: '.', quoted: false, tilde: false }, env, roots);
      operands.forEach((w) => provePath(w, env, roots));
      return;
  }
}

function realOrNull(p: string): string | null {
  try { return realpathSync(p); } catch { return null; }
}

/**
 * Prove a bash command against the grammar. Never throws.
 */
export function proveBashCommand(command: string, env: ProofEnv): BashProof {
  let program = 'other';
  try {
    if (command.length > MAX_PROVEN_LENGTH) throw new NotProven('length');
    const segments = lex(command);
    if (segments.length > MAX_PROVEN_COMMANDS) throw new NotProven('length');
    const cwd = realOrNull(env.cwd);
    if (!cwd) throw new NotProven('root');
    const home = env.home ? (realOrNull(env.home) ?? env.home) : undefined;
    // A working directory that is the file system root, or that contains HOME, would
    // prove reads of the whole home; nothing with a path is proven from there.
    const tooWide = dirname(cwd) === cwd || (home !== undefined && within(home, cwd));
    const roots: Roots = {
      cwd,
      read: env.readRoots.map(realOrNull).filter((r): r is string => r !== null),
      home: env.home,
      pathsAllowed: !tooWide,
    };
    for (const seg of segments) {
      const name = seg.words[0]!.text;
      program = Object.hasOwn(PROGRAMS, name) ? name : 'other';
      proveSegment(seg, env, roots);
    }
    program = Object.hasOwn(PROGRAMS, segments[0]!.words[0]!.text) ? segments[0]!.words[0]!.text : 'other';
    return { proven: true, reason: 'ok', program };
  } catch (err) {
    if (err instanceof NotProven) return { proven: false, reason: err.reason, program };
    return { proven: false, reason: 'path-unresolvable', program };
  }
}
