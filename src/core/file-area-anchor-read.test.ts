import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * readAreaText refuses a file over its limit by the open file's size, before reading, and again
 * while reading: a file that grows after the size check is cut off. readSync is counted and can
 * grow the file at its first call, the moment no static setup reaches.
 */
const h = vi.hoisted(() => ({ reads: 0, onFirstRead: null as null | (() => void) }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      if (h.reads++ === 0 && h.onFirstRead) h.onFirstRead();
      return actual.readSync(...args);
    },
  };
});

const { mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } = await import('node:fs');
const { areaTarget, readAreaText } = await import('./file-area-anchor.js');
const { setTenantWorkspace, clearTenantWorkspace } = await import('./workspace.js');
const { closeWorkspaceBase } = await import('./workspace-rel.js');

let ws: string;

beforeEach(() => {
  h.reads = 0;
  h.onFirstRead = null;
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-area-read-')));
  setTenantWorkspace(ws);
});

afterEach(() => {
  closeWorkspaceBase();
  clearTenantWorkspace();
  rmSync(ws, { recursive: true, force: true });
});

describe('readAreaText', () => {
  it('reads a file up to the limit', () => {
    writeFileSync(join(ws, 'a.txt'), 'x'.repeat(16));
    expect(readAreaText(areaTarget('a.txt')!, 16, 'too large')).toBe('x'.repeat(16));
  });

  it('refuses a file over the limit before reading a byte', () => {
    writeFileSync(join(ws, 'b.txt'), 'x'.repeat(17));
    expect(() => readAreaText(areaTarget('b.txt')!, 16, 'too large')).toThrow('too large');
    expect(h.reads).toBe(0);
  });

  it('cuts off a file that grows past the limit after the size check', () => {
    writeFileSync(join(ws, 'c.txt'), 'small');
    h.onFirstRead = () => truncateSync(join(ws, 'c.txt'), 64);
    // The size check passed (5 bytes); the read sees the grown file and stops at the limit.
    expect(() => readAreaText(areaTarget('c.txt')!, 16, 'too large')).toThrow('too large');
    expect(h.reads).toBeGreaterThan(0);
  });
});
