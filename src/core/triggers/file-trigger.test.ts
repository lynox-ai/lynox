import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TriggerCallback, TriggerEvent } from '../../types/index.js';

// Mock node:fs before importing FileTrigger
const mockClose = vi.fn();
const mockOn = vi.fn(function (this: object) { return this; });
const mockWatch = vi.fn(() => ({ close: mockClose, on: mockOn }));
const mockReaddirSync = vi.fn<(path: string, options?: unknown) => Array<{ name: string; isDirectory(): boolean }>>(() => []);

vi.mock('node:fs', () => ({
  watch: mockWatch,
  readdirSync: mockReaddirSync,
}));

// Import after mock is set up
const { FileTrigger } = await import('./file-trigger.js');

describe('FileTrigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockReaddirSync.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls watch(dir, { recursive: true }) on start', () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    trigger.start(vi.fn(() => Promise.resolve()));

    expect(mockWatch).toHaveBeenCalledTimes(1);
    expect(mockWatch).toHaveBeenCalledWith(
      expect.stringContaining('/tmp/test'),
      { recursive: true },
      expect.any(Function),
    );

    trigger.stop();
  });

  it('fires callback after debounce with correct payload', async () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    const events: TriggerEvent[] = [];
    const callback: TriggerCallback = async (event) => { events.push(event); };

    trigger.start(callback);

    // Get the watcher callback
    const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[2] as (event: string, filename: string) => void;
    watcherCallback('change', 'src/app.ts');

    // Not yet — still within debounce window
    expect(events).toHaveLength(0);

    // Advance past default debounce (500ms)
    await vi.advanceTimersByTimeAsync(500);

    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe('file');
    expect((events[0]!.payload as any).files).toContain('src/app.ts');
    expect(typeof events[0]!.timestamp).toBe('string');

    trigger.stop();
  });

  it('ignores dotfiles (e.g. .gitignore)', async () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

    trigger.start(callback);

    const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[2] as (event: string, filename: string) => void;
    watcherCallback('change', '.gitignore');

    await vi.advanceTimersByTimeAsync(500);
    expect(callback).not.toHaveBeenCalled();

    trigger.stop();
  });

  it('ignores node_modules paths', async () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

    trigger.start(callback);

    const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[2] as (event: string, filename: string) => void;
    watcherCallback('change', 'node_modules/pkg/index.js');

    await vi.advanceTimersByTimeAsync(500);
    expect(callback).not.toHaveBeenCalled();

    trigger.stop();
  });

  it('ignores null filename', async () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

    trigger.start(callback);

    const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[2] as (event: string, filename: string | null) => void;
    watcherCallback('change', null as any);

    await vi.advanceTimersByTimeAsync(500);
    expect(callback).not.toHaveBeenCalled();

    trigger.stop();
  });

  it('debounces rapid changes into a single callback', async () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    const events: TriggerEvent[] = [];
    const callback: TriggerCallback = async (event) => { events.push(event); };

    trigger.start(callback);

    const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[2] as (event: string, filename: string) => void;

    // Fire rapidly
    watcherCallback('change', 'file1.ts');
    watcherCallback('change', 'file2.ts');
    watcherCallback('change', 'file3.ts');

    await vi.advanceTimersByTimeAsync(500);

    // Should batch into a single callback
    expect(events).toHaveLength(1);
    const files = (events[0]!.payload as any).files as string[];
    expect(files).toContain('file1.ts');
    expect(files).toContain('file2.ts');
    expect(files).toContain('file3.ts');

    trigger.stop();
  });

  it('respects custom debounceMs', async () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test', debounceMs: 1000 });
    const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

    trigger.start(callback);

    const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[2] as (event: string, filename: string) => void;
    watcherCallback('change', 'test.ts');

    // Not yet at 500ms (default would have fired)
    await vi.advanceTimersByTimeAsync(500);
    expect(callback).not.toHaveBeenCalled();

    // At 1000ms — should fire now
    await vi.advanceTimersByTimeAsync(500);
    expect(callback).toHaveBeenCalledTimes(1);

    trigger.stop();
  });

  it('applies glob filter — only matching files pass through', async () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test', glob: '*.ts' });
    const events: TriggerEvent[] = [];
    const callback: TriggerCallback = async (event) => { events.push(event); };

    trigger.start(callback);

    const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[2] as (event: string, filename: string) => void;

    watcherCallback('change', 'app.ts');     // matches *.ts
    watcherCallback('change', 'style.css');  // does NOT match *.ts

    await vi.advanceTimersByTimeAsync(500);

    expect(events).toHaveLength(1);
    const files = (events[0]!.payload as any).files as string[];
    expect(files).toContain('app.ts');
    expect(files).not.toContain('style.css');

    trigger.stop();
  });

  it('stop closes watcher and clears timer', () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    trigger.start(vi.fn(() => Promise.resolve()));

    trigger.stop();

    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('is safe to call stop without start', () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    expect(() => trigger.stop()).not.toThrow();
  });

  it('falls back to non-recursive watch when recursive mode is unavailable', () => {
    mockWatch
      .mockImplementationOnce(() => {
        const err = new Error('recursive unsupported') as Error & { code?: string };
        err.code = 'EINVAL';
        throw err;
      })
      .mockImplementationOnce(() => ({ close: mockClose, on: mockOn }));

    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    trigger.start(vi.fn(() => Promise.resolve()));

    expect(mockWatch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/tmp/test'),
      { recursive: true },
      expect.any(Function),
    );
    expect(mockWatch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/tmp/test'),
      expect.any(Function),
    );

    trigger.stop();
  });

  it('fallback mode watches nested subdirectories and reports relative paths', async () => {
    const dirent = (name: string, isDirectory: boolean) => ({
      name,
      isDirectory: () => isDirectory,
    });

    mockWatch
      .mockImplementationOnce(() => {
        const err = new Error('recursive unsupported') as Error & { code?: string };
        err.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
        throw err;
      })
      .mockImplementation(() => ({ close: mockClose, on: mockOn }));
    mockReaddirSync.mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.endsWith('/tmp/test')) {
        return [dirent('nested', true), dirent('root.ts', false)];
      }
      if (p.endsWith('/tmp/test/nested')) {
        return [dirent('deep.ts', false)];
      }
      return [];
    });

    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    const events: TriggerEvent[] = [];
    trigger.start(async (event) => { events.push(event); });

    expect(mockWatch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/tmp/test'),
      expect.any(Function),
    );
    expect(mockWatch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('/tmp/test/nested'),
      expect.any(Function),
    );

    const nestedWatcherCallback = (mockWatch.mock.calls[2] as unknown[])[1] as (event: string, filename: string) => void;
    nestedWatcherCallback('change', 'deep.ts');

    await vi.advanceTimersByTimeAsync(500);

    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { files: string[] }).files).toContain('nested/deep.ts');

    trigger.stop();
  });

  it('swallows rejected callback promises after the debounce fires', async () => {
    const trigger = new FileTrigger({ type: 'file', dir: '/tmp/test' });
    const callback = vi.fn<TriggerCallback>().mockRejectedValue(new Error('boom'));

    trigger.start(callback);

    const watcherCallback = (mockWatch.mock.calls[0] as unknown[])[2] as (event: string, filename: string) => void;
    watcherCallback('change', 'src/app.ts');

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();

    expect(callback).toHaveBeenCalledTimes(1);

    trigger.stop();
  });
});
