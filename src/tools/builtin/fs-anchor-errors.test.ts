import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * An error from the fd walk carries the process-handle path it was opened through. Whatever its
 * form, the model sees the workspace path instead. The forms the filesystem does not produce on
 * demand are thrown here from a stand-in for `openRead`.
 */
const thrown: { err: unknown } = { err: null };

vi.mock('../../core/workspace-fd.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/workspace-fd.js')>();
  return {
    ...real,
    openRead: (...args: Parameters<typeof real.openRead>) => {
      if (thrown.err !== null) throw thrown.err;
      return real.openRead(...args);
    },
  };
});

const { readFileTool } = await import('./fs.js');
const { setTenantWorkspace, clearTenantWorkspace } = await import('../../core/workspace.js');
const { closeWorkspaceBase } = await import('../../core/workspace-rel.js');

const FD = '/proc/self/fd/9/a.txt';

function errno(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

let ws: string;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-anchor-err-')));
  writeFileSync(join(ws, 'a.txt'), 'A');
  setTenantWorkspace(ws);
});

afterEach(() => {
  thrown.err = null;
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
});

async function messageFor(err: unknown): Promise<string> {
  thrown.err = err;
  return readFileTool.handler({ path: join(ws, 'a.txt') }).then(() => 'no error', (e: unknown) => (e as Error).message);
}

describe('an fd error shown to the model', () => {
  it('reads the file when nothing is thrown (a control on the stand-in)', async () => {
    expect(await readFileTool.handler({ path: join(ws, 'a.txt') })).toContain('A');
  });

  it('keeps the description of an errno and swaps its path', async () => {
    expect(await messageFor(errno('EBUSY', `EBUSY: resource busy or locked, open '${FD}'`)))
      .toBe(`read_file: EBUSY: resource busy or locked: ${join(ws, 'a.txt')}`);
  });

  it('shows only the code for a message in another form, which may carry the path anywhere', async () => {
    expect(await messageFor(errno('ERR_FS_SOMETHING', `could not use ${FD}`)))
      .toBe(`read_file: ERR_FS_SOMETHING: ${join(ws, 'a.txt')}`);
    // The errno form, but what follows the code is no description.
    expect(await messageFor(errno('EIO', `EIO: ${FD}`))).toBe(`read_file: EIO: ${join(ws, 'a.txt')}`);
    // Not the errno form, though the text after the code's length happens to be words only.
    expect(await messageFor(errno('EIO', 'xxxx some other words'))).toBe(`read_file: EIO: ${join(ws, 'a.txt')}`);
  });

  it('shows only the code for an error with an empty message or none', async () => {
    expect(await messageFor(errno('EIO', ''))).toBe(`read_file: EIO: ${join(ws, 'a.txt')}`);
    expect(await messageFor({ code: 'EIO' })).toBe(`read_file: EIO: ${join(ws, 'a.txt')}`);
  });
});
