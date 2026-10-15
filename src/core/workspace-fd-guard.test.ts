import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `workspace-fd.ts` reaches the workspace through `/proc/self/fd/<n>/<name>`, one component at a
 * time with O_NOFOLLOW. Any other engine code that builds such a path hands the rest of the walk
 * to the kernel, which follows symlinks below the anchor (the module's header says so). This
 * guard keeps that construction in the one module, and `process.chdir` (which would make relative
 * paths resolve somewhere else) at the places that have a reason. It catches mistakes, not intent.
 */
const SRC = join(import.meta.dirname, '..');

/** A path through a process's fd table, root or cwd: the constructions only the fd module may build. */
const FD_PATH = /\/proc\/(?:self|thread-self|\$\{[^}]*\}|\d+)\/(?:fd|root|cwd)(?:\/|`|'|")|\/dev\/fd\//;

const FD_PATH_ALLOWED: Record<string, string> = {
  'core/workspace-fd.ts': 'the fd walk itself',
};
const CHDIR_ALLOWED: Record<string, string> = {
  'index.ts': 'the CLI entry changes into the project directory before any engine starts',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const FILES = sources(SRC).map(p => ({ rel: relative(SRC, p), text: readFileSync(p, 'utf8') }));

describe('workspace fd guard', () => {
  it('reads the source tree and recognises the construction (controls)', () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES.map(f => f.rel)).toContain('core/workspace-fd.ts');
    for (const s of ['`/proc/self/fd/${fd}/`', "'/proc/self/root/x'", '"/proc/1/cwd"', '`/proc/${pid}/fd/3`', "'/dev/fd/3/a'"]) {
      expect(FD_PATH.test(s), s).toBe(true);
    }
    for (const s of ['`/proc/self/fdinfo/${fd}`', "'/proc/self/status'", "'/dev/null'"]) {
      expect(FD_PATH.test(s), s).toBe(false);
    }
    expect(FD_PATH.test(FILES.find(f => f.rel === 'core/workspace-fd.ts')!.text)).toBe(true);
  });

  it('builds a path through /proc/<pid>/fd, /root, /cwd or /dev/fd only in the fd module', () => {
    const found = FILES.filter(f => FD_PATH.test(f.text) && FD_PATH_ALLOWED[f.rel] === undefined).map(f => f.rel);
    expect(found).toEqual([]);
  });

  it('changes the working directory only where it is allowed', () => {
    const found = FILES.filter(f => /process\.chdir\s*\(/.test(f.text) && CHDIR_ALLOWED[f.rel] === undefined).map(f => f.rel);
    expect(found).toEqual([]);
  });

  it('keeps no allowance for a file that no longer needs it', () => {
    for (const rel of Object.keys(FD_PATH_ALLOWED)) expect(FD_PATH.test(FILES.find(f => f.rel === rel)?.text ?? ''), rel).toBe(true);
    for (const rel of Object.keys(CHDIR_ALLOWED)) expect(/process\.chdir\s*\(/.test(FILES.find(f => f.rel === rel)?.text ?? ''), rel).toBe(true);
  });
});
