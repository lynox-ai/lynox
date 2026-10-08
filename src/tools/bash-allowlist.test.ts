import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proveBashCommand, PROGRAMS, MAX_PROVEN_LENGTH, MAX_PROVEN_COMMANDS, type ProofEnv, type ProofReason } from './bash-allowlist.js';

// Built at load time: the `it.each` tables below are evaluated before any hook runs.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'bash-allowlist-')));
const home = join(base, 'home');
const ws = join(base, 'ws');
const readRoot = join(base, 'app');
mkdirSync(join(ws, 'sub'), { recursive: true });
mkdirSync(join(home, '.ssh'), { recursive: true });
mkdirSync(readRoot, { recursive: true });
writeFileSync(join(ws, 'notes.md'), 'x');
writeFileSync(join(ws, 'sub', 'data.csv'), 'a,b');
writeFileSync(join(ws, 'creds.key'), 'k');
writeFileSync(join(home, '.ssh', 'id_ed25519'), 'k');
writeFileSync(join(home, 'plain.txt'), 'x');
writeFileSync(join(readRoot, 'readme'), 'x');
writeFileSync(join(base, 'outside.txt'), 'x');
symlinkSync(join(base, 'outside.txt'), join(ws, 'link-out'));
symlinkSync(join(ws, 'notes.md'), join(ws, 'link-in'));
execFileSync('mkfifo', [join(ws, 'pipe')]);
// A symlink inside the directory whose target's PARENT holds a file outside it.
mkdirSync(join(ws, 'a', 'b'), { recursive: true });
mkdirSync(join(base, 'x', 'y'), { recursive: true });
writeFileSync(join(base, 'x', 'leak.txt'), 'x');
symlinkSync(join(base, 'x', 'y'), join(ws, 'a', 'b', 'l'));
// A symlink OUTSIDE that points inside, and a working directory reached through a symlink.
symlinkSync(join(ws, 'notes.md'), join(base, 'into-ws'));
symlinkSync(ws, join(base, 'ws-link'));
const env: ProofEnv = {
  cwd: ws,
  home,
  readRoots: [readRoot],
  isSensitive: (p) => /\.key$|id_ed25519|\.ssh\//.test(p),
};

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const prove = (cmd: string, e: ProofEnv = env) => proveBashCommand(cmd, e);

describe('proveBashCommand — proven', () => {
  it.each([
    'ls',
    'ls -la',
    'ls -l sub',
    'ls -1',
    'grep /etc/passwd notes.md',
    'cat notes.md',
    'cat -n notes.md sub/data.csv',
    'cat ./notes.md',
    'cat link-in',
    'cat -',
    "cat '-'",
    'head -n 5 notes.md',
    'head -n5 notes.md',
    'head --lines=5 notes.md',
    'head -n -5 notes.md',
    'tail -n +2 sub/data.csv',
    'wc -l notes.md',
    'grep -i foo notes.md',
    "grep -e 'a b' notes.md sub/data.csv",
    "grep --regexp=x -c notes.md",
    'grep -C 2 foo notes.md',
    'grep -- -foo notes.md',
    "cut -d, -f1 sub/data.csv",
    "cut -d ' ' -f 2 sub/data.csv",
    "tr a-z A-Z",
    "uniq -c sub/data.csv",
    'pwd',
    'echo hello world',
    'echo -n hi',
    "echo 'a$b`c'",
    'stat notes.md',
    'date',
    'date -u +%Y-%m-%d',
    "date '+%Y %m'",
    'cat notes.md | grep x | wc -l',
    'ls && pwd',
    'ls ; pwd',
    'cat notes.md 2>/dev/null',
    'cat notes.md 2>/dev/null | wc -l',
    'cat\tnotes.md',
    'cat missing-file.md',
    `cat ${'x'.repeat(10)}.md`,
    `cat ${join(base, 'app', 'readme')}`,
  ])('proves %s', (cmd) => {
    expect(prove(cmd)).toEqual(expect.objectContaining({ proven: true, reason: 'ok' }));
  });

  it('expands ~ from HOME', () => {
    // A working directory inside HOME is fine; only one that CONTAINS HOME is too wide.
    const e = { ...env, home: base };
    expect(prove('cat ~/ws/notes.md', e).proven).toBe(true);
    expect(prove('cat ~/outside.txt', e)).toEqual(expect.objectContaining({ proven: false, reason: 'path-outside' }));
  });

  it('names the program of the first command', () => {
    expect(prove('cat notes.md | wc -l').program).toBe('cat');
  });
});

describe('proveBashCommand — not proven', () => {
  const cases: Array<[string, ProofReason]> = [
    // bytes and characters
    ['cat "notes.md"', 'char'],
    ['cat $HOME/x', 'char'],
    ['cat `pwd`', 'char'],
    ['cat $(pwd)', 'char'],
    ['cat no*.md', 'char'],
    ['cat no?es.md', 'char'],
    ['cat {a,b}', 'char'],
    ['cat [n]otes.md', 'char'],
    ['cat notes.md # x', 'char'],
    ['cat notes.md\\', 'char'],
    ['echo !x', 'char'],
    ['ls\npwd', 'byte'],
    ['cat noétes', 'byte'],
    ['cat \u0000', 'byte'],
    ["cat 'a\nb'", 'byte'],
    ["cat 'notes", 'quote'],
    // separators
    ['ls || pwd', 'separator'],
    ['ls |& pwd', 'separator'],
    ['ls & pwd', 'separator'],
    ['ls ;; pwd', 'separator'],
    ['ls |', 'separator'],
    ['| ls', 'separator'],
    ['ls ;', 'separator'],
    ['', 'separator'],
    // redirections
    ['cat notes.md > out', 'redirect'],
    ['cat < notes.md', 'char'],
    ['cat notes.md 2>/dev/null x', 'redirect'],
    ['cat notes.md x2>/dev/null', 'redirect'],
    ["cat notes.md '2'>/dev/null", 'redirect'],
    ['cat notes.md 2>/dev/nullx', 'redirect'],
    ['cat notes.md 2>/dev/null 2>/dev/null', 'redirect'],
    ['cat notes.md 2>/tmp/x', 'redirect'],
    // tilde
    ['cat ~root/x', 'tilde'],
    ['cat ~+/x', 'tilde'],
    ['cat x~', 'tilde'],
    ["cat ~'/x'", 'tilde'],
    ['echo ~', 'tilde'],
    // program head
    ['PATH=/tmp cat notes.md', 'program'],
    ['cat notes.md | X=1 wc', 'program'],
    ['./cat notes.md', 'program'],
    ['/bin/cat notes.md', 'program'],
    ["'cat' notes.md", 'program'],
    ['cd sub', 'program'],
    ['find . -name x', 'program'],
    ['rg x', 'program'],
    ['jq . x', 'program'],
    ['git diff', 'program'],
    ['du -sh .', 'program'],
    ['file notes.md', 'program'],
    ['sort notes.md', 'program'],
    ['sh -c ls', 'program'],
    ['env ls', 'program'],
    ['__proto__ x', 'program'],
    ['cat notes.md | ./bin', 'program'],
    // options
    ['tail -f notes.md', 'option'],
    ['tail -F notes.md', 'option'],
    ['tail --follow notes.md', 'option'],
    ['tail --pid=1 notes.md', 'option'],
    ['tail -5f notes.md', 'option'],
    ['head -5 notes.md', 'option'],
    ['grep -r foo .', 'option'],
    ['grep -R foo .', 'option'],
    ['grep --recursive foo .', 'option'],
    ['grep -f patterns notes.md', 'option'],
    ['grep --include=x foo notes.md', 'option'],
    ['grep -d recurse foo .', 'option'],
    ['grep --rec foo .', 'option'],
    ['ls -R', 'option'],
    ['stat -c %n notes.md', 'option'],
    ['stat --printf=x notes.md', 'option'],
    ['date -s 2020-01-01', 'option'],
    ['date --set=x', 'option'],
    ['echo -e x', 'option'],
    ['echo -n -n x', 'option'],
    ['cat -Z notes.md', 'option'],
    ['wc --files0-from=x', 'option'],
    ['cat --number=1 notes.md', 'option'],
    ['head -n', 'option'],
    ['head --lines', 'option'],
    // values
    ['head -n x notes.md', 'value'],
    ['head -c 1x notes.md', 'value'],
    ['head -n ~ notes.md', 'value'],
    // operands
    ['pwd sub', 'operand'],
    ['date 010100002020', 'operand'],
    ['date +%s +%s', 'operand'],
    ['uniq notes.md out.txt', 'operand'],
    ['tr a b c', 'operand'],
    ['grep', 'operand'],
    ['grep ~ notes.md', 'tilde'],
    ['grep -e ~ notes.md', 'tilde'],
    ['tr ~ x', 'tilde'],
    ['grep -e x ../outside.txt', 'path-outside'],
    ['grep --regexp=x ../outside.txt', 'path-outside'],
    // paths
    ['cat ../outside.txt', 'path-outside'],
    ['cat link-out', 'path-outside'],
    ['cat /etc/passwd', 'path-outside'],
    ['ls /', 'path-outside'],
    ['cat ~/plain.txt', 'path-outside'],
    ['grep x ../outside.txt', 'path-outside'],
    ['cat creds.key', 'path-sensitive'],
    ['cat pipe', 'path-special'],
    ['cat a/b/l/../leak.txt', 'path-outside'],
    ['grep -e x a/b/l/../leak.txt', 'path-outside'],
    ['ls a/b/l/..', 'path-outside'],
    ['ls a/b/l', 'path-outside'],
    ['cat sub/../notes.md', 'path-outside'],
    [`cat ${join(base, 'into-ws')}`, 'path-outside'],
    ['tail +1f notes.md', 'operand'],
    ['tail +1f', 'operand'],
    ['tail -- +1f', 'operand'],
    ['df -h .', 'program'],
    [`cat ${'a/'.repeat(10)}../../../../../../../../../../../outside.txt`, 'path-outside'],
  ];

  it.each(cases)('%s → %s', (cmd, reason) => {
    expect(prove(cmd)).toEqual(expect.objectContaining({ proven: false, reason }));
  });

  it('is not proven above the length cap, and is proven just under it', () => {
    const under = 'echo ' + 'a'.repeat(MAX_PROVEN_LENGTH - 5);
    expect(under.length).toBe(MAX_PROVEN_LENGTH);
    expect(prove(under).proven).toBe(true);
    expect(prove(under + 'a')).toEqual(expect.objectContaining({ proven: false, reason: 'length' }));
  });

  it('proves no path without HOME for a ~ operand', () => {
    expect(prove('cat ~/notes.md', { ...env, home: undefined })).toEqual(expect.objectContaining({ proven: false, reason: 'no-home' }));
  });

  it('proves no path from a working directory that contains HOME or is the root', () => {
    const containsHome = { ...env, cwd: base, home };
    expect(prove('cat ws/notes.md', containsHome)).toEqual(expect.objectContaining({ proven: false, reason: 'root' }));
    expect(prove('ls', containsHome)).toEqual(expect.objectContaining({ proven: false, reason: 'root' }));
    // Commands without a path stay proven there, and so does stdin.
    expect(prove('pwd', containsHome).proven).toBe(true);
    expect(prove('cat -', containsHome).proven).toBe(true);
    expect(prove('echo hi', containsHome).proven).toBe(true);
    expect(prove('cat /etc/hostname', { ...env, cwd: '/' })).toEqual(expect.objectContaining({ proven: false, reason: 'root' }));
    // The root is too wide on its own, also when no HOME tells it so.
    expect(prove('cat /etc/hostname', { ...env, cwd: '/', home: undefined })).toEqual(expect.objectContaining({ proven: false, reason: 'root' }));
  });

  it('proves from a working directory reached through a symlink, against its real path', () => {
    const viaLink = { ...env, cwd: join(base, 'ws-link') };
    expect(prove('cat notes.md', viaLink).proven).toBe(true);
    // An absolute path written through the same symlink, as `pwd` prints it.
    expect(prove(`cat ${join(base, 'ws-link', 'notes.md')}`, viaLink).proven).toBe(true);
    expect(prove('cat ../outside.txt', viaLink)).toEqual(expect.objectContaining({ proven: false, reason: 'path-outside' }));
  });

  it('proves at most MAX_PROVEN_COMMANDS commands in one call', () => {
    const commands = (n: number) => Array.from({ length: n }, () => 'pwd').join(' | ');
    expect(prove(commands(MAX_PROVEN_COMMANDS)).proven).toBe(true);
    expect(prove(commands(MAX_PROVEN_COMMANDS + 1))).toEqual(expect.objectContaining({ proven: false, reason: 'length' }));
  });

  it('is not proven when the working directory cannot be resolved', () => {
    expect(prove('pwd', { ...env, cwd: join(base, 'gone') })).toEqual(expect.objectContaining({ proven: false, reason: 'root' }));
  });

  it('checks every command of a pipeline and names the one that failed', () => {
    expect(prove('cat notes.md | grep -r x .')).toEqual({ proven: false, reason: 'option', program: 'grep' });
    expect(prove('cat notes.md | curl x')).toEqual({ proven: false, reason: 'program', program: 'other' });
  });

  it('never names a program off the list', () => {
    expect(prove('mysecretbinary --x').program).toBe('other');
  });
});

describe('PROGRAMS', () => {
  it('lists no program with a known executing or writing mode', () => {
    for (const name of ['find', 'rg', 'jq', 'git', 'du', 'df', 'file', 'sort', 'sh', 'bash', 'env', 'xargs', 'tee', 'cd']) {
      expect(Object.hasOwn(PROGRAMS, name)).toBe(false);
    }
  });

  it('leaves out the options the review found writing, following or recursing', () => {
    expect(Object.hasOwn(PROGRAMS['tail']!.short, 'f')).toBe(false);
    expect(Object.hasOwn(PROGRAMS['tail']!.short, 'F')).toBe(false);
    expect(Object.hasOwn(PROGRAMS['grep']!.short, 'r')).toBe(false);
    expect(Object.hasOwn(PROGRAMS['grep']!.short, 'f')).toBe(false);
    expect(Object.hasOwn(PROGRAMS['ls']!.short, 'R')).toBe(false);
    expect(Object.hasOwn(PROGRAMS['date']!.short, 's')).toBe(false);
  });
});

describe('proveBashCommand — runtime', () => {
  it('rejects a long input at the cap without reading it', () => {
    const t0 = performance.now();
    expect(prove('cat ' + './'.repeat(500_000)).reason).toBe('length');
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it('stays fast on the worst shapes under the cap', () => {
    const t0 = performance.now();
    expect(prove('ls|'.repeat(MAX_PROVEN_COMMANDS - 1) + 'ls').proven).toBe(true);
    expect(prove('cat ' + './'.repeat(2000) + 'notes.md').proven).toBe(true);
    expect(prove("echo '" + 'x'.repeat(4000) + "'").proven).toBe(true);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
