import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * batch_files transform reads a file, then writes it in place. A file removed in between is not
 * made again: the write opens the file it read, or fails. The removal is forced at the read.
 */
const h = vi.hoisted(() => ({ removeAfterOpen: null as null | string }));

vi.mock('../../core/workspace-fd.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/workspace-fd.js')>('../../core/workspace-fd.js');
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    openRead: (...args: Parameters<typeof actual.openRead>) => {
      const fd = actual.openRead(...args);
      if (h.removeAfterOpen !== null) fs.unlinkSync(h.removeAfterOpen);
      return fd;
    },
  };
});

const { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
const { batchFilesTool } = await import('./batch-files.js');
const { setTenantWorkspace, clearTenantWorkspace } = await import('../../core/workspace.js');
const { closeWorkspaceBase } = await import('../../core/workspace-rel.js');

let ws: string;

beforeEach(() => {
  h.removeAfterOpen = null;
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-batch-race-')));
  setTenantWorkspace(ws);
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
});

describe('batch_files transform between its read and its write', () => {
  it('does not make again a file removed after it was read', async () => {
    writeFileSync(join(ws, 'gone.txt'), 'old');
    h.removeAfterOpen = join(ws, 'gone.txt');
    const out = await batchFilesTool.handler({ pattern: '*.txt', directory: ws, operation: 'transform', find: 'old', replace: 'new' } as never, {} as never);
    expect(out).toContain(`Error transforming ${join(ws, 'gone.txt')}: ENOENT`);
    expect(existsSync(join(ws, 'gone.txt'))).toBe(false);
  });
});
