import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Spinner } from './spinner.js';

describe('Spinner', () => {
  let spinner: Spinner;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    spinner = new Spinner();
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    spinner.stop();
    vi.useRealTimers();
    stderrWriteSpy.mockRestore();
  });

  it('start() makes isActive() return true', () => {
    expect(spinner.isActive()).toBe(false);
    spinner.start('Loading');
    expect(spinner.isActive()).toBe(true);
  });

  it('stop() makes isActive() return false', () => {
    spinner.start('Loading');
    expect(spinner.isActive()).toBe(true);
    spinner.stop();
    expect(spinner.isActive()).toBe(false);
  });

  it('writes to stderr on interval tick', () => {
    spinner.start('Processing');
    expect(stderrWriteSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(stderrWriteSpy).toHaveBeenCalled();

    const output = stderrWriteSpy.mock.calls[0]![0] as string;
    expect(output).toContain('Processing');
  });

  it('start() when already started is a no-op', () => {
    spinner.start('First');
    vi.advanceTimersByTime(80);
    const callsAfterFirst = stderrWriteSpy.mock.calls.length;

    // Starting again should not create a second interval
    spinner.start('Second');
    vi.advanceTimersByTime(80);

    // Should only have one additional call (from the original interval),
    // not two (which would happen if a second interval was created)
    const callsAfterSecond = stderrWriteSpy.mock.calls.length;
    expect(callsAfterSecond - callsAfterFirst).toBe(1);
  });

  it('stop() when not started is a no-op', () => {
    expect(() => spinner.stop()).not.toThrow();
    expect(spinner.isActive()).toBe(false);
  });

  it('stop() clears the line on stderr', () => {
    spinner.start('Loading');
    stderrWriteSpy.mockClear();

    spinner.stop();
    expect(stderrWriteSpy).toHaveBeenCalledWith('\r\x1b[K');
  });

  it('updateLabel() changes the displayed label while keeping spinner active', () => {
    spinner.start('Loading');
    expect(spinner.isActive()).toBe(true);

    vi.advanceTimersByTime(80);
    const firstOutput = stderrWriteSpy.mock.calls[0]![0] as string;
    expect(firstOutput).toContain('Loading');

    stderrWriteSpy.mockClear();
    spinner.updateLabel('Retrying...');
    expect(spinner.isActive()).toBe(true);

    vi.advanceTimersByTime(80);
    const updatedOutput = stderrWriteSpy.mock.calls[0]![0] as string;
    expect(updatedOutput).toContain('Retrying...');
    expect(updatedOutput).not.toContain('Loading');
  });

  it('updateLabel() is a no-op when spinner is not active', () => {
    spinner.updateLabel('test');
    expect(spinner.isActive()).toBe(false);
  });
});
