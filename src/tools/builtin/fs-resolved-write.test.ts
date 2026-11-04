import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile, link, readdir, stat, chmod } from 'node:fs/promises';
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
const refusalOf = (run: () => void): string => {
  try { run(); } catch (err) { return (err as Error).message; }
  return '';
};
const linkText = (path: string): string =>
  `${path}: a link on the way to the file is not followed here; nothing was written. ` +
  'If the link was set while the file was being written, writing it once more checks the path anew. ' +
  'If the same refusal comes back, the link leads to nothing that exists: write the file to another path, ' +
  'or tell the user that this path cannot be written because of a link on it.';
const secondNameText = (path: string): string =>
  `${path} has more than one name (a hard link); the file tools do not write such a file, so nothing was written. ` +
  'Write the changed content to a new file under another name instead, and tell the user which file now holds it.';

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
    expect(refusalOf(() => writeResolvedFile(ws('a.txt'), 'pwned', true))).toBe(linkText(ws('a.txt')));
    expect(await readFile(join(outside, 'target.txt'), 'utf-8')).toBe('outside\n');
  });

  it('refuses a folder on the way that turned into a link, and writes nothing there', async () => {
    await symlink(outside, ws('sub'));
    expect(() => writeResolvedFile(ws('sub', 'new.txt'), 'pwned', true)).toThrow(/a link on the way to the file is not followed here/);
    expect(await readdir(outside)).toEqual(['target.txt']);
  });

  it('refuses a file with a second name, word for word, and leaves it as it was', async () => {
    await writeFile(ws('a.txt'), 'hello');
    await link(ws('a.txt'), join(outside, 'second.txt'));
    expect(refusalOf(() => writeResolvedFile(ws('a.txt'), 'pwned', false))).toBe(secondNameText(ws('a.txt')));
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

  it('write_file without a workspace refuses a dead link every time, and creates nothing where it points', async () => {
    const away = join(outside, 'not-there.txt');
    await symlink(away, ws('dead.txt'));
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(writeFileTool.handler({ path: 'dead.txt', content: 'pwned' }, agent())).rejects.toThrow(
        `write_file: ${linkText(ws('dead.txt'))}`,
      );
    }
    expect(await readdir(outside)).toEqual(['target.txt']);
  });

  it('control: write_file without a workspace still writes through a link that stays in its folder, to its target', async () => {
    await writeFile(ws('real.txt'), 'old');
    await symlink('real.txt', ws('alias.txt'));
    await writeFileTool.handler({ path: 'alias.txt', content: 'new' }, agent());
    expect(await readFile(ws('real.txt'), 'utf-8')).toBe('new');
  });

  it.each([['write_file'], ['edit_file']] as const)('%s with a workspace refuses a file with a second name in /tmp', async (tool) => {
    const tenantWs = join(outside, 'ws');
    await mkdir(tenantWs, { recursive: true });
    setTenantWorkspace(tenantWs);
    // /tmp itself, not tmpdir(): /tmp is the root validatePath lets a write reach besides the workspace.
    const tmpDir = realpathSync(await mkdtemp('/tmp/lynox-rw-tmp-'));
    try {
      const tmpFile = join(tmpDir, 'tmp-file.txt');
      await writeFile(tmpFile, 'hello world');
      await link(tmpFile, join(tmpDir, 'second.txt'));
      const run = tool === 'write_file'
        ? writeFileTool.handler({ path: tmpFile, content: 'pwned' }, agent())
        : editFileTool.handler({ path: tmpFile, old_string: 'hello', new_string: 'pwned' }, agent());
      await expect(run).rejects.toThrow(`${tool}: ${secondNameText(tmpFile)}`);
      expect(await readFile(join(tmpDir, 'second.txt'), 'utf-8')).toBe('hello world');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('edit_file without a workspace refuses a file with a second name before it compares anything', async () => {
    await writeFile(ws('notes.txt'), 'hello world');
    await link(ws('notes.txt'), join(outside, 'second.txt'));
    // old_string is not in the file: an answer "not found" would tell the content.
    await expect(editFileTool.handler({ path: 'notes.txt', old_string: 'absent', new_string: 'x' }, agent())).rejects.toThrow(
      `edit_file: ${secondNameText(ws('notes.txt'))}`,
    );
  });

  it('write_file says a refused open by the file\'s own path, not by a process handle', async () => {
    await writeFile(ws('ro.txt'), 'x');
    await chmod(ws('ro.txt'), 0o444);
    const message = await writeFileTool.handler({ path: 'ro.txt', content: 'y' }, agent()).then(() => '', (err: Error) => err.message);
    if (process.getuid?.() === 0) return; // root writes a read-only file; nothing is refused
    expect(message).toBe(`write_file: EACCES: permission denied: ${ws('ro.txt')}`);
  });
});

describe('a file with a second name in the workspace folder gets the same refusal', () => {
  it.each([['write_file'], ['edit_file']] as const)('%s, word for word', async (tool) => {
    const tenantWs = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-rw-ws-')));
    try {
      setTenantWorkspace(tenantWs);
      await writeFile(join(tenantWs, 'notes.txt'), 'hello world');
      await link(join(tenantWs, 'notes.txt'), join(outside, 'second.txt'));
      const run = tool === 'write_file'
        ? writeFileTool.handler({ path: join(tenantWs, 'notes.txt'), content: 'pwned' }, agent())
        : editFileTool.handler({ path: join(tenantWs, 'notes.txt'), old_string: 'hello', new_string: 'pwned' }, agent());
      const message = await run.then(() => '', (err: Error) => err.message);
      expect(message).toBe(`${tool}: ${secondNameText(join(tenantWs, 'notes.txt'))}`);
      expect(await readFile(join(outside, 'second.txt'), 'utf-8')).toBe('hello world');
    } finally {
      clearTenantWorkspace();
      await rm(tenantWs, { recursive: true, force: true });
    }
  });
});
