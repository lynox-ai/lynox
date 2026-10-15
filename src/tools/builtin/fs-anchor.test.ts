import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, closeSync, constants, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as builtins from './index.js';
import { readFileTool, writeFileTool, editFileTool } from './fs.js';
import { setTenantWorkspace, clearTenantWorkspace } from '../../core/workspace.js';
import { closeWorkspaceBase } from '../../core/workspace-rel.js';
import type { IAgent, SessionCounters, ToolEntry } from '../../types/index.js';

function agent(): IAgent {
  const sessionCounters = { writeBytes: 0, httpRequests: 0 } as unknown as SessionCounters;
  return { sessionCounters } as unknown as IAgent;
}

let ws: string;
let outside: string;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-anchor-ws-')));
  // Under /tmp, which `validatePath` allows for reads and writes: a link from the workspace to it
  // passed the old check, so it shows whether the write goes through the link or the anchor.
  outside = realpathSync(mkdtempSync('/tmp/lynox-anchor-out-'));
  setTenantWorkspace(ws);
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('file tools reach the workspace through its open directory', () => {
  it('does not follow a directory link in the workspace, even to an allowed root', async () => {
    symlinkSync(outside, join(ws, 'sub'));
    await expect(writeFileTool.handler({ path: join(ws, 'sub', 'x.txt'), content: 'x' }, agent())).rejects.toThrow(/sub is a symlink/);
    expect(existsSync(join(outside, 'x.txt'))).toBe(false);

    writeFileSync(join(outside, 'y.txt'), 'outside');
    await expect(readFileTool.handler({ path: join(ws, 'sub', 'y.txt') })).rejects.toThrow(/sub is a symlink/);
    await expect(editFileTool.handler({ path: join(ws, 'sub', 'y.txt'), old_string: 'outside', new_string: 'changed' }, agent()))
      .rejects.toThrow(/sub is a symlink/);
    expect(readFileSync(join(outside, 'y.txt'), 'utf8')).toBe('outside');
  });

  it('refuses a path outside that reaches a workspace file through a link', async () => {
    writeFileSync(join(ws, 'secret.txt'), 'in the workspace');
    symlinkSync(join(ws, 'secret.txt'), join(outside, 'lnk'));
    await expect(readFileTool.handler({ path: join(outside, 'lnk') })).rejects.toThrow(/reaches the workspace through a link/);
    await expect(writeFileTool.handler({ path: join(outside, 'lnk'), content: 'over' }, agent())).rejects.toThrow(/reaches the workspace through a link/);
    expect(readFileSync(join(ws, 'secret.txt'), 'utf8')).toBe('in the workspace');
    // The control: a plain file under /tmp is still a file tool's to read and write.
    writeFileSync(join(outside, 'plain.txt'), 'tmp');
    expect(await readFileTool.handler({ path: join(outside, 'plain.txt') })).toContain('tmp');
    await writeFileTool.handler({ path: join(outside, 'plain.txt'), content: 'tmp2' }, agent());
    expect(readFileSync(join(outside, 'plain.txt'), 'utf8')).toBe('tmp2');
  });

  it('refuses a workspace file named through /proc', async () => {
    writeFileSync(join(ws, 'a.txt'), 'A');
    await expect(readFileTool.handler({ path: `/proc/self/root${ws}/a.txt` })).rejects.toThrow(/process handle/);
    await expect(writeFileTool.handler({ path: `/proc/self/root${ws}/a.txt`, content: 'B' }, agent())).rejects.toThrow(/process handle/);
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('A');
    expect(await readFileTool.handler({ path: join(ws, 'a.txt') })).toContain('A');
  });

  it('refuses a FIFO in the workspace instead of blocking on it', async () => {
    execFileSync('mkfifo', [join(ws, 'pipe')]);
    await expect(readFileTool.handler({ path: join(ws, 'pipe') })).rejects.toThrow(/not a regular file/);
  });

  it('refuses to write a FIFO even while something reads it, when opening it does not fail', async () => {
    execFileSync('mkfifo', [join(ws, 'pipe')]);
    // With a reader present, opening for writing succeeds; only the type check is left.
    const reader = openSync(join(ws, 'pipe'), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      await expect(writeFileTool.handler({ path: join(ws, 'pipe'), content: 'into the pipe' }, agent())).rejects.toThrow(/not a regular file/);
    } finally {
      closeSync(reader);
    }
  });

  it('refuses the workspace directory itself as a file', async () => {
    await expect(readFileTool.handler({ path: ws })).rejects.toThrow(`${ws} is the workspace directory itself, not a file.`);
    await expect(writeFileTool.handler({ path: ws, content: 'x' }, agent())).rejects.toThrow(/is the workspace directory itself/);
  });

  it('keeps the mode of a file it rewrites or edits', async () => {
    writeFileSync(join(ws, 'run.sh'), 'echo one\n');
    chmodSync(join(ws, 'run.sh'), 0o750);
    await writeFileTool.handler({ path: join(ws, 'run.sh'), content: 'echo two\n' }, agent());
    expect(statSync(join(ws, 'run.sh')).mode & 0o777).toBe(0o750);
    await editFileTool.handler({ path: join(ws, 'run.sh'), old_string: 'two', new_string: 'three' }, agent());
    expect(statSync(join(ws, 'run.sh')).mode & 0o777).toBe(0o750);
    expect(readFileSync(join(ws, 'run.sh'), 'utf8')).toBe('echo three\n');

  });

  it.each(['022', '077', '002'])('makes a new file and directory as a write by name does under umask %s', async (octal) => {
    const mask = parseInt(octal, 8);
    const before = process.umask(mask);
    try {
      await writeFileTool.handler({ path: join(ws, 'deep', 'new.txt'), content: 'n' }, agent());
      mkdirSync(join(ws, 'byname'));
      writeFileSync(join(ws, 'byname', 'new.txt'), 'n');
    } finally {
      process.umask(before);
    }
    expect(statSync(join(ws, 'deep', 'new.txt')).mode & 0o777).toBe(0o666 & ~mask);
    expect(statSync(join(ws, 'deep')).mode & 0o777).toBe(0o777 & ~mask);
    // The same as the write by name it replaces.
    expect(statSync(join(ws, 'deep', 'new.txt')).mode & 0o777).toBe(statSync(join(ws, 'byname', 'new.txt')).mode & 0o777);
    expect(statSync(join(ws, 'deep')).mode & 0o777).toBe(statSync(join(ws, 'byname')).mode & 0o777);
  });

  it('keeps the set-group-ID bit a new directory inherits, as a mkdir by name does', async () => {
    // The test runs as a member of the directory's group (its own); otherwise the kernel clears
    // the bit on fchmod whatever the mode says, and this would test nothing.
    chmodSync(ws, 0o2775);
    await writeFileTool.handler({ path: join(ws, 'shared', 'f.txt'), content: 'f' }, agent());
    mkdirSync(join(ws, 'byname'));
    expect(statSync(join(ws, 'byname')).mode & 0o2000).toBe(0o2000);
    expect(statSync(join(ws, 'shared')).mode & 0o2000).toBe(0o2000);
    expect(statSync(join(ws, 'shared')).gid).toBe(statSync(ws).gid);
  });

  it('writes and edits a workspace file in place: same inode, so owner and permissions stay', async () => {
    writeFileSync(join(ws, 'keep.txt'), 'one');
    const ino = statSync(join(ws, 'keep.txt')).ino;
    await writeFileTool.handler({ path: join(ws, 'keep.txt'), content: 'two' }, agent());
    expect(statSync(join(ws, 'keep.txt')).ino).toBe(ino);
    await editFileTool.handler({ path: join(ws, 'keep.txt'), old_string: 'two', new_string: 'three' }, agent());
    expect(statSync(join(ws, 'keep.txt')).ino).toBe(ino);
    expect(readFileSync(join(ws, 'keep.txt'), 'utf8')).toBe('three');
  });

  it.skipIf(process.getuid?.() === 0)('leaves a read-only file unwritten, as a write by name does (skipped as root)', async () => {
    writeFileSync(join(ws, 'ro.txt'), 'fixed');
    chmodSync(join(ws, 'ro.txt'), 0o444);
    await expect(writeFileTool.handler({ path: join(ws, 'ro.txt'), content: 'over' }, agent())).rejects.toThrow(`EACCES: permission denied: ${join(ws, 'ro.txt')}`);
    await expect(editFileTool.handler({ path: join(ws, 'ro.txt'), old_string: 'fixed', new_string: 'over' }, agent())).rejects.toThrow(/EACCES/);
    expect(readFileSync(join(ws, 'ro.txt'), 'utf8')).toBe('fixed');
  });

  it('refuses a file with a second name, which may be outside the workspace', async () => {
    writeFileSync(join(outside, 'target.txt'), 'kept');
    linkSync(join(outside, 'target.txt'), join(ws, 'hard.txt'));
    await expect(writeFileTool.handler({ path: join(ws, 'hard.txt'), content: 'over' }, agent())).rejects.toThrow(/hard link/);
    await expect(editFileTool.handler({ path: join(ws, 'hard.txt'), old_string: 'kept', new_string: 'over' }, agent())).rejects.toThrow(/hard link/);
    // The same answer whether old_string occurs or not: otherwise edit_file tells what read_file refuses.
    await expect(editFileTool.handler({ path: join(ws, 'hard.txt'), old_string: 'absent', new_string: 'over' }, agent())).rejects.toThrow(/hard link/);
    await expect(readFileTool.handler({ path: join(ws, 'hard.txt') })).rejects.toThrow(/hard link/);
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('kept');
  });

  it('edits only an existing file and never through a link at the file', async () => {
    await expect(editFileTool.handler({ path: join(ws, 'none.txt'), old_string: 'a', new_string: 'b' }, agent()))
      .rejects.toThrow(/file does not exist/);
    writeFileSync(join(ws, 'real.txt'), 'abc');
    symlinkSync(join(ws, 'real.txt'), join(ws, 'link.txt'));
    await expect(editFileTool.handler({ path: join(ws, 'link.txt'), old_string: 'abc', new_string: 'xyz' }, agent()))
      .rejects.toThrow(/link.txt is a symlink/);
    expect(readFileSync(join(ws, 'real.txt'), 'utf8')).toBe('abc');
  });

  it('reads and writes a name with a backslash, an ordinary character on Linux', async () => {
    await writeFileTool.handler({ path: join(ws, 'a\\b.txt'), content: 'bs' }, agent());
    expect(readFileSync(join(ws, 'a\\b.txt'), 'utf8')).toBe('bs');
    expect(await readFileTool.handler({ path: join(ws, 'a\\b.txt') })).toContain('bs');
  });

  it('tells the model how to reach what a link points to', async () => {
    mkdirSync(join(ws, 'real'));
    writeFileSync(join(ws, 'real', 'f.txt'), 'via the real path');
    symlinkSync(join(ws, 'real'), join(ws, 'alias'));
    await expect(readFileTool.handler({ path: join(ws, 'alias', 'f.txt') })).rejects.toThrow(/name the file it points to by its own path/);
    expect(await readFileTool.handler({ path: join(ws, 'real', 'f.txt') })).toContain('via the real path');
  });

  it('refuses a path with a trailing slash instead of making a file of it', async () => {
    await expect(writeFileTool.handler({ path: `${join(ws, 'newdir')}/`, content: 'x' }, agent())).rejects.toThrow(/names a directory/);
    expect(existsSync(join(ws, 'newdir'))).toBe(false);
  });

  it('reads and edits the file in the directory it holds, not whatever the name means now', async () => {
    writeFileSync(join(ws, 'f.txt'), 'held A');
    await readFileTool.handler({ path: join(ws, 'f.txt') });
    // The directory moves away and another takes its name: the tools keep to the one they opened.
    const moved = `${ws}-moved`;
    renameSync(ws, moved);
    mkdirSync(ws);
    writeFileSync(join(ws, 'f.txt'), 'named A');
    try {
      await editFileTool.handler({ path: join(ws, 'f.txt'), old_string: 'A', new_string: 'B' }, agent());
      expect(readFileSync(join(moved, 'f.txt'), 'utf8')).toBe('held B');
      expect(readFileSync(join(ws, 'f.txt'), 'utf8')).toBe('named A');
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it('answers with the workspace path of what it wrote', async () => {
    const out = await writeFileTool.handler({ path: join(ws, 'n', 'o.txt'), content: 'o' }, agent());
    expect(out).toBe(`Written to ${join(ws, 'n', 'o.txt')}`);
  });
});

/**
 * Every built-in tool, taken from the module that exports them, with each string field whose name
 * says it may carry a path. A field nobody classified fails here: a new path-taking tool has to
 * say whether its field is a filesystem path, and if it is, either go through the workspace's
 * open directory or stand in PENDING with the change that moves it.
 */
const FIELD = /path|dir|destination|file|input|cwd/i;
const KIND: Record<string, Record<string, 'fs' | 'not-fs'>> = {
  read_file: { path: 'fs' },
  write_file: { path: 'fs' },
  edit_file: { path: 'fs' },
  batch_files: { directory: 'fs', destination: 'fs', rename_pattern: 'fs' },
  media_process: { input: 'fs' },
  bulk_plan: { source_file: 'fs', 'source_list.path': 'not-fs' },
  api_setup: { path: 'not-fs' },
  spawn_agent: { 'agents.profile': 'not-fs' },
};
const CONVERTED = new Set(['read_file', 'write_file', 'edit_file', 'batch_files', 'media_process', 'bulk_plan']);
/** Moved onto the workspace's open directory by the next changes; this list only shrinks. */
const PENDING = new Set<string>([]);
/** The rest of a valid input per converted tool, so the path field is what decides. */
const REST = (dir: string): Record<string, Record<string, unknown>> => ({
  read_file: {},
  write_file: { content: 'B' },
  edit_file: { old_string: 'A', new_string: 'B' },
  batch_files: { pattern: '*.txt', directory: dir, operation: 'move', destination: dir, rename_pattern: '$1.md' },
  media_process: { operation: 'transcode', format: 'mp4' },
  bulk_plan: { target_system: 'workspace' },
});
/** A field that is a name joined to another path, never a path of its own: a handle in it names a
 *  directory below the workspace, and the call may fail — it must not reach the handle. */
const JOINED = new Set(['batch_files.rename_pattern']);

function stringFields(schema: unknown, prefix = ''): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (props === undefined) return [];
  const out: string[] = [];
  for (const [name, def] of Object.entries(props)) {
    const d = def as { type?: unknown; properties?: unknown; items?: unknown };
    const key = prefix === '' ? name : `${prefix}.${name}`;
    if (d.type === 'string' && FIELD.test(name)) out.push(key);
    if (d.properties !== undefined) out.push(...stringFields(d, key));
    if (typeof d.items === 'object' && d.items !== null) out.push(...stringFields(d.items, key));
  }
  return out;
}

const TOOLS = Object.values(builtins).filter(
  (v): v is ToolEntry => typeof v === 'object' && v !== null && 'definition' in v && 'handler' in v,
);

describe('every built-in tool that takes a filesystem path', () => {
  it('found the tools (a control on the source of the list)', () => {
    expect(TOOLS.length).toBeGreaterThan(30);
    expect(TOOLS.map(t => t.definition.name)).toContain('read_file');
  });

  it('classifies each path-like field', () => {
    const unclassified: string[] = [];
    for (const t of TOOLS) {
      for (const f of stringFields(t.definition.input_schema)) {
        if (KIND[t.definition.name]?.[f] === undefined) unclassified.push(`${t.definition.name}.${f}`);
      }
    }
    expect(unclassified).toEqual([]);
  });

  it('either reaches the workspace through its open directory or is pending, and nothing else', () => {
    const fsTools = Object.entries(KIND).filter(([, fields]) => Object.values(fields).includes('fs')).map(([name]) => name).sort();
    expect([...CONVERTED, ...PENDING].sort()).toEqual(fsTools);
    for (const name of PENDING) expect(CONVERTED.has(name)).toBe(false);
  });

  it('refuses process-handle paths in every converted field, and touches nothing', async () => {
    writeFileSync(join(ws, 'a.txt'), 'A');
    // bulk_plan refuses without a ledger before it looks at its source; the ledger is never reached.
    const withLedger = { ...agent(), toolContext: { bulkLedger: {} } } as unknown as IAgent;
    const handles = [`/proc/self/fd/3/a.txt`, `/dev/fd/3/a.txt`, `/proc/thread-self/fd/3/a.txt`, `/proc/1/root${ws}/a.txt`, `/proc/self/root${ws}/a.txt`];
    for (const t of TOOLS.filter(x => CONVERTED.has(x.definition.name))) {
      for (const [field, kind] of Object.entries(KIND[t.definition.name]!)) {
        if (kind !== 'fs') continue;
        const name = `${t.definition.name}.${field}`;
        for (const p of handles) {
          const input: Record<string, unknown> = { ...REST(ws)[t.definition.name], [field]: p };
          if (field === 'rename_pattern') input['operation'] = 'rename';
          // A tool says no by throwing, or (bulk_plan) by an error result.
          const said = await t.handler(input as never, withLedger).then(String, (e: unknown) => `threw: ${(e as Error).message}`);
          if (JOINED.has(name)) expect(said, `${name} ${p}`).not.toMatch(/^Renamed|→/m);
          else expect(said, `${name} ${p}`).toMatch(/process handle/);
          expect(readFileSync(join(ws, 'a.txt'), 'utf8'), `${name} ${p}`).toBe('A');
        }
      }
    }
  });
});

describe('without isolation', () => {
  it('leaves the file tools on their CLI rules (out of this change)', async () => {
    clearTenantWorkspace();
    closeWorkspaceBase();
    const d = mkdtempSync(join(tmpdir(), 'lynox-cli-'));
    try {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'c.txt'), 'cli');
      expect(await readFileTool.handler({ path: join(d, 'c.txt') })).toContain('cli');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
