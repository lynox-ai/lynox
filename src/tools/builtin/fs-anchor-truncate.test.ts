import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Truncating a file that is new or already empty is not only useless: on ext4 a truncate to zero
 * makes the following close flush the data synchronously (auto_da_alloc), which made writing a
 * new file several times slower than a write by name. So only a file with content is truncated.
 */
const counts = { ftruncate: 0 };

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const ftruncateSync = (...args: Parameters<typeof real.ftruncateSync>) => {
    counts.ftruncate++;
    return real.ftruncateSync(...args);
  };
  return { ...real, default: { ...real, ftruncateSync }, ftruncateSync };
});

const { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
const { writeFileTool, editFileTool } = await import('./fs.js');
const { setTenantWorkspace, clearTenantWorkspace } = await import('../../core/workspace.js');
const { closeWorkspaceBase } = await import('../../core/workspace-rel.js');
import type { IAgent, SessionCounters } from '../../types/index.js';

const agent = (): IAgent => ({ sessionCounters: { writeBytes: 0, httpRequests: 0 } as unknown as SessionCounters }) as unknown as IAgent;

let ws: string;

beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-anchor-trunc-')));
  setTenantWorkspace(ws);
  counts.ftruncate = 0;
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
});

describe('writing a workspace file in place', () => {
  it('does not truncate a new or empty file, and does truncate one with content', async () => {
    await writeFileTool.handler({ path: join(ws, 'new.txt'), content: 'n' }, agent());
    writeFileSync(join(ws, 'empty.txt'), '');
    await writeFileTool.handler({ path: join(ws, 'empty.txt'), content: 'e' }, agent());
    expect(counts.ftruncate).toBe(0);

    await writeFileTool.handler({ path: join(ws, 'new.txt'), content: 'shorter? no: longer' }, agent());
    await editFileTool.handler({ path: join(ws, 'new.txt'), old_string: 'longer', new_string: 'l' }, agent());
    expect(counts.ftruncate).toBe(2);
    // The truncate is what keeps a shorter rewrite from leaving the old tail behind.
    expect(readFileSync(join(ws, 'new.txt'), 'utf8')).toBe('shorter? no: l');
  });
});
