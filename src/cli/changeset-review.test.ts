import { describe, it, expect, vi } from 'vitest';
import { reviewChangeset } from './changeset-review.js';
import type { ChangesetDiff } from '../types/index.js';
import { EventEmitter } from 'node:events';

function makeStdin(keys: string[]): NodeJS.ReadStream {
  let idx = 0;
  const emitter = new EventEmitter() as NodeJS.ReadStream;
  emitter.isTTY = true;
  emitter.isRaw = false;
  emitter.setRawMode = vi.fn().mockReturnThis();
  emitter.resume = vi.fn();
  emitter.pause = vi.fn();

  // Override `on` to immediately trigger data events
  const origOn = emitter.on.bind(emitter);
  emitter.on = ((event: string, listener: (...args: unknown[]) => void) => {
    origOn(event, listener);
    if (event === 'data' && idx < keys.length) {
      const key = keys[idx]!;
      idx++;
      process.nextTick(() => listener(Buffer.from(key)));
    }
    return emitter;
  }) as typeof emitter.on;

  return emitter;
}

function makeStdout(): NodeJS.WriteStream & { output: string } {
  const out = {
    output: '',
    write(chunk: string | Uint8Array): boolean {
      out.output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      return true;
    },
    isTTY: true,
  } as unknown as NodeJS.WriteStream & { output: string };
  return out;
}

function makeDiff(overrides: Partial<ChangesetDiff> = {}): ChangesetDiff {
  return {
    file: 'test.txt',
    absolutePath: '/tmp/test.txt',
    status: 'modified',
    diff: '--- a/test.txt\n+++ b/test.txt\n@@ -1 +1 @@\n-old\n+new',
    originalContent: 'old',
    ...overrides,
  };
}

describe('reviewChangeset', () => {
  it('should accept all on "a" key', async () => {
    const stdin = makeStdin(['a']);
    const stdout = makeStdout();
    const changes = [makeDiff()];

    const result = await reviewChangeset(changes, stdin, stdout);

    expect(result.action).toBe('accept');
    expect(result.acceptedFiles).toEqual(['/tmp/test.txt']);
    expect(result.rolledBackFiles).toHaveLength(0);
  });

  it('should rollback all on "r" key', async () => {
    const stdin = makeStdin(['r']);
    const stdout = makeStdout();
    const changes = [makeDiff()];

    const result = await reviewChangeset(changes, stdin, stdout);

    expect(result.action).toBe('rollback');
    expect(result.rolledBackFiles).toEqual(['/tmp/test.txt']);
    expect(result.acceptedFiles).toHaveLength(0);
  });

  it('should handle partial review', async () => {
    // First key: 'p' for partial, then 'a' for first file, 'r' for second
    const stdin = makeStdin(['p', 'a', 'r']);
    const stdout = makeStdout();
    const changes = [
      makeDiff({ file: 'a.txt', absolutePath: '/tmp/a.txt' }),
      makeDiff({ file: 'b.txt', absolutePath: '/tmp/b.txt' }),
    ];

    const result = await reviewChangeset(changes, stdin, stdout);

    expect(result.action).toBe('partial');
    expect(result.acceptedFiles).toEqual(['/tmp/a.txt']);
    expect(result.rolledBackFiles).toEqual(['/tmp/b.txt']);
  });

  it('should display summary with file counts', async () => {
    const stdin = makeStdin(['a']);
    const stdout = makeStdout();
    const changes = [
      makeDiff({ status: 'modified' }),
      makeDiff({ file: 'new.txt', absolutePath: '/tmp/new.txt', status: 'added' }),
    ];

    await reviewChangeset(changes, stdin, stdout);

    expect(stdout.output).toContain('1 file modified');
    expect(stdout.output).toContain('1 file added');
  });

  it('should color diff lines', async () => {
    const stdin = makeStdin(['a']);
    const stdout = makeStdout();
    const changes = [makeDiff()];

    await reviewChangeset(changes, stdin, stdout);

    // Output should contain ANSI color codes for diff
    expect(stdout.output).toContain('\x1b[32m+new'); // green for additions
    expect(stdout.output).toContain('\x1b[31m-old'); // red for removals
  });

  it('should default to accept on unknown key', async () => {
    const stdin = makeStdin(['x']);
    const stdout = makeStdout();
    const changes = [makeDiff()];

    const result = await reviewChangeset(changes, stdin, stdout);

    expect(result.action).toBe('accept');
  });
});
