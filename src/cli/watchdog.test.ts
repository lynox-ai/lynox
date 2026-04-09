import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockStart = vi.fn();
const mockStop = vi.fn();

vi.mock('../core/triggers/file-trigger.js', () => {
  const MockFileTrigger = vi.fn(function (this: Record<string, unknown>) {
    this.start = mockStart;
    this.stop = mockStop;
  });
  return { FileTrigger: MockFileTrigger };
});

import { Watchdog } from './watchdog.js';
import { FileTrigger } from '../core/triggers/file-trigger.js';

describe('Watchdog', () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  const mockCallback = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.clearAllMocks();
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
  });

  it('constructor creates FileTrigger with correct config', () => {
    const _watchdog = new Watchdog('/some/dir', mockCallback, 300);

    expect(FileTrigger).toHaveBeenCalledWith({
      type: 'file',
      dir: expect.stringContaining('some/dir'),
      debounceMs: 300,
    });
  });

  it('start() calls FileTrigger.start() and writes "Watching" message', () => {
    const watchdog = new Watchdog('/some/dir', mockCallback);
    watchdog.start();

    expect(mockStart).toHaveBeenCalledOnce();
    expect(mockStart).toHaveBeenCalledWith(expect.any(Function));

    const written = stdoutWriteSpy.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .join('');
    expect(written).toContain('Watching');
  });

  it('stop() calls FileTrigger.stop() and writes "stopped" message', () => {
    const watchdog = new Watchdog('/some/dir', mockCallback);
    watchdog.stop();

    expect(mockStop).toHaveBeenCalledOnce();

    const written = stdoutWriteSpy.mock.calls
      .map((c: unknown[]) => c[0] as string)
      .join('');
    expect(written).toContain('stopped');
  });

  it('stop() sets trigger to null so second stop does not call FileTrigger.stop() again', () => {
    const watchdog = new Watchdog('/some/dir', mockCallback);
    watchdog.stop();
    expect(mockStop).toHaveBeenCalledOnce();

    mockStop.mockClear();
    watchdog.stop();
    // FileTrigger.stop() should not be called again since trigger is null
    expect(mockStop).not.toHaveBeenCalled();
  });
});
