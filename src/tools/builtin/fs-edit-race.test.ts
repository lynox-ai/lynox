import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { realpathSync, renameSync, symlinkSync, statSync, writeFileSync as writeNow } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * edit_file reads a file through its own handle, then writes the result. A link that takes the
 * file's place between the read and the write must be refused, not written through. A one-shot
 * hook on the handler's `fstatSync` sets the link in that window.
 */

// Runs once, on the first fstat of the file with this inode: the handler's own stat of the open file.
let swap: { ino: number; run: () => void } | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    fstatSync: ((...args: Parameters<typeof real.fstatSync>) => {
      const st = real.fstatSync(...args);
      if (swap !== null && st.isFile() && st.ino === swap.ino) {
        const { run } = swap;
        swap = null;
        run();
      }
      return st;
    }) as typeof real.fstatSync,
  };
});

const { editFileTool } = await import('./fs.js');
const { clearTenantWorkspace } = await import('../../core/workspace.js');

let root: string;
let outside: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-race-')));
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-race-out-')));
  prevDataDir = process.env['LYNOX_DATA_DIR'];
  process.env['LYNOX_DATA_DIR'] = root;
  clearTenantWorkspace();
  await mkdir(join(root, 'workspace'), { recursive: true });
  await writeFile(join(outside, 'target.txt'), 'outside\n');
});

afterEach(async () => {
  swap = null;
  clearTenantWorkspace();
  if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
  else process.env['LYNOX_DATA_DIR'] = prevDataDir;
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const agent = (): import('../../types/index.js').IAgent =>
  ({ sessionCounters: { writeBytes: 0 } } as unknown as import('../../types/index.js').IAgent);

describe('edit_file without a workspace, a link set between the read and the write', () => {
  it('is refused with the link text, and the file it points to is untouched', async () => {
    const notes = join(root, 'workspace', 'notes.txt');
    await writeFile(notes, 'hello world');
    swap = {
      ino: statSync(notes).ino,
      run: () => {
        renameSync(notes, `${notes}.old`);
        symlinkSync(join(outside, 'target.txt'), notes);
      },
    };
    const message = await editFileTool.handler({ path: 'notes.txt', old_string: 'hello', new_string: 'pwned' }, agent())
      .then(() => '', (err: Error) => err.message);
    expect(swap).toBeNull(); // the hook ran
    expect(message).toMatch(new RegExp(`^edit_file: ${notes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: a link on the way to the file is not followed here; nothing was written\\.`));
    expect(await readFile(join(outside, 'target.txt'), 'utf-8')).toBe('outside\n');
  });

  it('control: without the swap the edit is written', async () => {
    const notes = join(root, 'workspace', 'notes.txt');
    writeNow(notes, 'hello world');
    await editFileTool.handler({ path: 'notes.txt', old_string: 'hello', new_string: 'bye' }, agent());
    expect(await readFile(notes, 'utf-8')).toBe('bye world');
  });
});
