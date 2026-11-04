import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile, link, readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeArtifactFile, editFileTool, writeFileTool } from './fs.js';
import { clearTenantWorkspace, setTenantWorkspace } from '../../core/workspace.js';
import type { IAgent } from '../../types/index.js';

/**
 * A file in the artifacts directory is written through that directory's open handle: a link set
 * in after the path was resolved is refused, not followed out of the directory.
 */

let root: string;
let outside: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-artw-')));
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-artw-out-')));
  prevDataDir = process.env['LYNOX_DATA_DIR'];
  process.env['LYNOX_DATA_DIR'] = root;
  clearTenantWorkspace();
  await mkdir(join(root, 'artifacts'), { recursive: true });
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

describe('writeArtifactFile', () => {
  it('writes a file in the artifacts directory (control)', async () => {
    const path = join(root, 'artifacts', 'report.html');
    await writeFile(path, 'old');
    writeArtifactFile(path, 'new', false);
    expect(await readFile(path, 'utf-8')).toBe('new');
  });

  it('creates a missing file and its folder, with the modes a write by name gives them', async () => {
    const path = join(root, 'artifacts', 'a1', 'report.html');
    writeArtifactFile(path, 'made', true);
    expect(await readFile(path, 'utf-8')).toBe('made');
    const umask = process.umask();
    expect((await stat(path)).mode & 0o777).toBe(0o666 & ~umask);
    expect((await stat(join(root, 'artifacts', 'a1'))).mode & 0o777).toBe(0o777 & ~umask);
  });

  it('creates the artifacts directory itself when it is missing', async () => {
    await rm(join(root, 'artifacts'), { recursive: true, force: true });
    const path = join(root, 'artifacts', 'report.html');
    writeArtifactFile(path, 'first', true);
    expect(await readFile(path, 'utf-8')).toBe('first');
  });

  it('refuses a link at the file, and the file it points to is untouched', async () => {
    const path = join(root, 'artifacts', 'report.html');
    await symlink(join(outside, 'target.txt'), path);
    expect(() => writeArtifactFile(path, 'pwned', false)).toThrow(/link on the way to the file is not followed/);
    expect(await readFile(join(outside, 'target.txt'), 'utf-8')).toBe('outside\n');
  });

  const refusalOf = (path: string, create: boolean): string => {
    try { writeArtifactFile(path, 'pwned', create); } catch (err) { return (err as Error).message; }
    return '';
  };

  it('names the artifact id and the way out in its refusal, word for word', async () => {
    const path = join(root, 'artifacts', '7f3a91c2.html');
    await symlink(join(outside, 'target.txt'), path);
    expect(refusalOf(path, false)).toBe(
      `${path}: a link on the way to the file is not followed; nothing was written, and artifact 7f3a91c2 is unchanged. ` +
      'Tell the user that this artifact could not be changed, and that you are saving the changed version as a new artifact. ' +
      'Then call artifact_save without an id: passing 7f3a91c2 would write to the same file. ' +
      'In your reply, name the new artifact as the one that replaces it.',
    );
  });

  it.each([['a file name that is not an artifact id', 'report.html'], ['a file under versions/', 'versions/7f3a91c2.v1.html']])('names the way out without an id for %s, word for word', async (_label, rel) => {
    await mkdir(join(root, 'artifacts', 'versions'), { recursive: true });
    const path = join(root, 'artifacts', rel);
    await symlink(join(outside, 'target.txt'), path);
    expect(refusalOf(path, false)).toBe(
      `${path}: a link on the way to the file is not followed; nothing was written. ` +
      'Tell the user that this file could not be changed, and that you are saving the changed version as a new artifact. ' +
      'Then call artifact_save without an id. In your reply, name the new artifact as the one that replaces it.',
    );
  });

  it('refuses an artifact with a second name with the same way out, naming its id, word for word', async () => {
    const path = join(root, 'artifacts', '7f3a91c2.html');
    await writeFile(path, 'hello');
    await link(path, join(outside, 'second.html'));
    expect(refusalOf(path, false)).toBe(
      `${path} has more than one name (a hard link); the file tools do not write such a file, so nothing was written, and artifact 7f3a91c2 is unchanged. ` +
      'Do not write it under this name again, with any tool, bash included: that would change the file under its other name too. ' +
      'Tell the user that this artifact could not be changed, and that you are saving the changed version as a new artifact. ' +
      'Then call artifact_save without an id: passing 7f3a91c2 would write to the same file. ' +
      'In your reply, name the new artifact as the one that replaces it.',
    );
    expect(await readFile(join(outside, 'second.html'), 'utf-8')).toBe('hello');
  });

  it('refuses a file with a second name in the artifacts directory without an id, word for word', async () => {
    const path = join(root, 'artifacts', 'report.html');
    await writeFile(path, 'hello');
    await link(path, join(outside, 'second.html'));
    expect(refusalOf(path, false)).toBe(
      `${path} has more than one name (a hard link); the file tools do not write such a file, so nothing was written. ` +
      'Do not write it under this name again, with any tool, bash included: that would change the file under its other name too. ' +
      'Tell the user that this file could not be changed, and that you are saving the changed version as a new artifact. ' +
      'Then call artifact_save without an id. In your reply, name the new artifact as the one that replaces it.',
    );
  });

  it('refuses a linked folder on the way, and writes nothing outside', async () => {
    await symlink(outside, join(root, 'artifacts', 'sub'));
    expect(() => writeArtifactFile(join(root, 'artifacts', 'sub', 'new.html'), 'pwned', true)).toThrow(/link on the way/);
    expect(await readdir(outside)).toEqual(['target.txt']);
  });

  it('refuses a path outside the artifacts directory', () => {
    expect(() => writeArtifactFile(join(outside, 'target.txt'), 'x', false)).toThrow(/not in the artifacts directory/);
  });
});

describe('the file tools write an artifact through writeArtifactFile', () => {
  // A file with a second name: a write by name would change both; the handle-based write refuses.
  it('edit_file without a workspace refuses an artifact with a second name', async () => {
    const path = join(root, 'artifacts', 'report.html');
    await writeFile(path, 'hello world');
    await link(path, join(outside, 'second-name.html'));
    await expect(editFileTool.handler({ path, old_string: 'hello', new_string: 'bye' }, agent())).rejects.toThrow(/more than one name/);
    expect(await readFile(path, 'utf-8')).toBe('hello world');
  });

  it('control: edit_file without a workspace edits a plain artifact', async () => {
    const path = join(root, 'artifacts', 'report.html');
    await writeFile(path, 'hello world');
    await editFileTool.handler({ path, old_string: 'hello', new_string: 'bye' }, agent());
    expect(await readFile(path, 'utf-8')).toBe('bye world');
  });

  it.each([['write_file'], ['edit_file']] as const)('%s with a workspace refuses an artifact with a second name', async (tool) => {
    const ws = join(outside, 'ws');
    await mkdir(ws, { recursive: true });
    setTenantWorkspace(ws);
    const path = join(root, 'artifacts', 'report.html');
    await writeFile(path, 'hello world');
    await link(path, join(outside, 'second-name.html'));
    const run = tool === 'write_file'
      ? writeFileTool.handler({ path, content: 'bye world' }, agent())
      : editFileTool.handler({ path, old_string: 'hello', new_string: 'bye' }, agent());
    await expect(run).rejects.toThrow(/more than one name/);
    expect(await readFile(path, 'utf-8')).toBe('hello world');
  });
});
