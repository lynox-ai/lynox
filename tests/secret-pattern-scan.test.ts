/**
 * `scripts/secret-pattern-scan.sh`, the pre-commit credential scan, driven against
 * the REAL script in a throwaway repo: what it refuses, what it lets through, and
 * that a scan which could not run is never reported clean.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/secret-pattern-scan.sh', import.meta.url));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

// Built at run time so this file is not itself a staged credential.
const KEY = ['AKIA', 'Q'.repeat(16)].join('');

let dir: string;

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, env: GIT_ENV, stdio: 'ignore' });
}
function write(rel: string, body: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
}
function scan(cwd = dir): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT], { cwd, env: GIT_ENV, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pscan-'));
  git('init', '-q');
  write('src/base.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base', '--no-verify');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('secret-pattern-scan', () => {
  it('refuses a commit that adds a credential-shaped line, naming the file', () => {
    write('src/leak.ts', `export const k = '${KEY}';\n`);
    git('add', 'src/leak.ts');
    const r = scan();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('src/leak.ts');
  });

  it('lets a commit through that only deletes a file — no error about the missing path', () => {
    git('rm', '-q', 'src/base.ts');
    const r = scan();
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('judges the lines the commit adds, not a fixture already in the file', () => {
    write('src/fixture.ts', `const k = '${KEY}';\n`);
    git('add', '-A');
    git('commit', '-qm', 'fixture', '--no-verify');
    write('src/fixture.ts', `const k = '${KEY}';\nconst b = 2;\n`);
    git('add', 'src/fixture.ts');
    expect(scan().status).toBe(0);
  });

  it('reads the index, not the working tree: an unstaged key is not this commit', () => {
    write('src/base.ts', 'export const a = 2;\n');
    git('add', 'src/base.ts');
    write('src/base.ts', `export const a = '${KEY}';\n`);
    expect(scan().status).toBe(0);
  });

  it('scans a line changed while a file is renamed', () => {
    git('mv', 'src/base.ts', 'src/moved.ts');
    write('src/moved.ts', `export const a = '${KEY}';\n`);
    git('add', '-A');
    const r = scan();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('src/moved.ts');
  });

  it('a pure move of a file holding a key-shaped fixture adds no line, even with diff.renames off', () => {
    write('src/fixture.ts', `const k = '${KEY}';\n`);
    git('add', '-A');
    git('commit', '-qm', 'fixture', '--no-verify');
    git('config', 'diff.renames', 'false');
    git('mv', 'src/fixture.ts', 'src/elsewhere.ts');
    expect(scan().status).toBe(0);
  });

  it('reads a file git would call binary as its staged bytes', () => {
    write('data.bin', `x\0y\n${KEY}\n`);
    git('add', 'data.bin');
    expect(scan().status).toBe(1);
  });

  it('an added line beginning with `++ ` is content, not a file header', () => {
    write('src/notes.txt', `++ b/scripts/secret-pattern-scan.sh\nk=${KEY}\n`);
    git('add', 'src/notes.txt');
    expect(scan().status).toBe(1);
  });

  it('names files the same way when diff.noprefix is set', () => {
    git('config', 'diff.noprefix', 'true');
    write('abscripts/secret-pattern-scan.sh', `k=${KEY}\n`);
    git('add', '-A');
    expect(scan().status).toBe(1);
  });

  it('skips its own file, which holds the patterns it looks for', () => {
    write('scripts/secret-pattern-scan.sh', `# ${KEY}\n`);
    git('add', '-A');
    expect(scan().status).toBe(0);
  });

  it('exits 2, not 0, when it cannot read the staged changes', () => {
    const outside = mkdtempSync(join(tmpdir(), 'pscan-norepo-'));
    try {
      const r = scan(outside);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('did not run');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
