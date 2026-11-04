import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile, link, readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeResolvedFile, writeFileTool, editFileTool } from './fs.js';
import { clearTenantWorkspace, setTenantWorkspace } from '../../core/workspace.js';
import type { IAgent } from '../../types/index.js';

/**
 * A file outside the artifacts directory and the workspace's open directory is written from its
 * path as resolved at the check, every component opened again without following links: a link
 * that turns up on the way after the check is refused, and so is a file with a second name.
 */

let root: string;
let outside: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-rw-')));
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-rw-out-')));
  prevDataDir = process.env['LYNOX_DATA_DIR'];
  process.env['LYNOX_DATA_DIR'] = root;
  clearTenantWorkspace();
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(outside, 'target.txt'), 'outside\n');
});

afterEach(async () => {
  clearTenantWorkspace();
  if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
  else process.env['LYNOX_DATA_DIR'] = prevDataDir;
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const agent = (): IAgent => ({ sessionCounters: { writeBytes: 0 } } as unknown as IAgent);
const ws = (...p: string[]): string => join(root, 'workspace', ...p);

describe('writeResolvedFile', () => {
  it('writes and replaces a file (control)', async () => {
    await writeFile(ws('a.txt'), 'old and longer');
    writeResolvedFile(ws('a.txt'), 'new', false);
    expect(await readFile(ws('a.txt'), 'utf-8')).toBe('new');
  });

  it('creates a missing file and its folders, with the modes a write by name gives them', async () => {
    writeResolvedFile(ws('d1', 'd2', 'a.txt'), 'made', true);
    expect(await readFile(ws('d1', 'd2', 'a.txt'), 'utf-8')).toBe('made');
    const umask = process.umask();
    expect((await stat(ws('d1', 'd2', 'a.txt'))).mode & 0o777).toBe(0o666 & ~umask);
    expect((await stat(ws('d1'))).mode & 0o777).toBe(0o777 & ~umask);
  });

  it('refuses a link that turned up at the file after the check, word for word, and leaves its target as it was', async () => {
    await symlink(join(outside, 'target.txt'), ws('a.txt'));
    let message = '';
    try { writeResolvedFile(ws('a.txt'), 'pwned', true); } catch (err) { message = (err as Error).message; }
    expect(message).toBe(
      `${ws('a.txt')}: a link turned up on the way to the file after its path was checked; nothing was written. ` +
      'Write the file again: its path is then checked anew.',
    );
    expect(await readFile(join(outside, 'target.txt'), 'utf-8')).toBe('outside\n');
  });

  it('refuses a folder on the way that turned into a link, and writes nothing there', async () => {
    await symlink(outside, ws('sub'));
    expect(() => writeResolvedFile(ws('sub', 'new.txt'), 'pwned', true)).toThrow(/link turned up on the way/);
    expect(await readdir(outside)).toEqual(['target.txt']);
  });

  it('refuses a file with a second name, and leaves it as it was', async () => {
    await writeFile(ws('a.txt'), 'hello');
    await link(ws('a.txt'), join(outside, 'second.txt'));
    expect(() => writeResolvedFile(ws('a.txt'), 'pwned', false)).toThrow(/more than one name/);
    expect(await readFile(join(outside, 'second.txt'), 'utf-8')).toBe('hello');
  });

  it('refuses a path that is not absolute', () => {
    expect(() => writeResolvedFile('workspace/a.txt', 'x', true)).toThrow(/not a resolved file path/);
  });
});

describe('the file tools write outside the artifacts directory through writeResolvedFile', () => {
  it.each([['write_file'], ['edit_file']] as const)('%s without a workspace refuses a file with a second name in the workspace', async (tool) => {
    await writeFile(ws('notes.txt'), 'hello world');
    await link(ws('notes.txt'), join(outside, 'second.txt'));
    const run = tool === 'write_file'
      ? writeFileTool.handler({ path: 'notes.txt', content: 'pwned' }, agent())
      : editFileTool.handler({ path: 'notes.txt', old_string: 'hello', new_string: 'pwned' }, agent());
    await expect(run).rejects.toThrow(/more than one name/);
    expect(await readFile(join(outside, 'second.txt'), 'utf-8')).toBe('hello world');
  });

  it.each([['write_file'], ['edit_file']] as const)('control: %s without a workspace writes a plain file', async (tool) => {
    await writeFile(ws('notes.txt'), 'hello world');
    if (tool === 'write_file') await writeFileTool.handler({ path: 'notes.txt', content: 'bye world' }, agent());
    else await editFileTool.handler({ path: 'notes.txt', old_string: 'hello', new_string: 'bye' }, agent());
    expect(await readFile(ws('notes.txt'), 'utf-8')).toBe('bye world');
  });

  it('control: write_file without a workspace still writes through a link that stays in its folder, to its target', async () => {
    await writeFile(ws('real.txt'), 'old');
    await symlink('real.txt', ws('alias.txt'));
    await writeFileTool.handler({ path: 'alias.txt', content: 'new' }, agent());
    expect(await readFile(ws('real.txt'), 'utf-8')).toBe('new');
  });

  it.each([['write_file'], ['edit_file']] as const)('%s with a workspace refuses a file with a second name outside it', async (tool) => {
    const tenantWs = join(outside, 'ws');
    await mkdir(tenantWs, { recursive: true });
    setTenantWorkspace(tenantWs);
    const tmpFile = join(root, 'tmp-file.txt');
    await writeFile(tmpFile, 'hello world');
    await link(tmpFile, join(outside, 'second.txt'));
    const run = tool === 'write_file'
      ? writeFileTool.handler({ path: tmpFile, content: 'pwned' }, agent())
      : editFileTool.handler({ path: tmpFile, old_string: 'hello', new_string: 'pwned' }, agent());
    await expect(run).rejects.toThrow(/more than one name/);
    expect(await readFile(join(outside, 'second.txt'), 'utf-8')).toBe('hello world');
  });
});
