import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, fsyncSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomicSync } from './atomic-write.js';

// Wrap only fsyncSync (still calling through to the real impl) so the durability
// flush is observable; every other node:fs export stays real via the spread.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

describe('writeFileAtomicSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-atomic-'));
    vi.mocked(fsyncSync).mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the content correctly through the fsync path (creating parent dirs)', () => {
    const target = join(dir, 'nested', 'config.json');
    writeFileAtomicSync(target, '{"k":1}');
    expect(readFileSync(target, 'utf-8')).toBe('{"k":1}');
  });

  it('fsyncs the file data for durability (not just an unflushed writeFileSync)', () => {
    writeFileAtomicSync(join(dir, 'durable.txt'), 'payload');
    // Pre-fix this used a bare writeFileSync (no flush) — zero fsync calls. The
    // temp file's data fd must be fsynced before the rename (the parent-dir
    // fsync is a best-effort extra call).
    expect(vi.mocked(fsyncSync)).toHaveBeenCalled();
  });
});
