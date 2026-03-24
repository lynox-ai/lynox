import { describe, it, expect, vi } from 'vitest';
import { StatusBar } from './status-bar.js';

function mockStream(cols = 80): NodeJS.WriteStream {
  return {
    isTTY: true,
    columns: cols,
    write: vi.fn(() => true),
  } as unknown as NodeJS.WriteStream;
}

describe('StatusBar', () => {
  it('returns empty string without content', () => {
    const bar = new StatusBar();
    expect(bar.render(mockStream())).toBe('');
  });

  it('returns empty string in non-TTY', () => {
    const bar = new StatusBar();
    bar.update('test');
    const s = { ...mockStream(), isTTY: false } as unknown as NodeJS.WriteStream;
    expect(bar.render(s)).toBe('');
  });

  it('returns status line with trailing RESET and newline', () => {
    const bar = new StatusBar();
    bar.update('model info');
    const result = bar.render(mockStream());
    expect(result).toContain('model info');
    expect(result).toContain('\x1b[0m'); // RESET
    expect(result.endsWith('\n')).toBe(true);
  });

  it('clear resets content', () => {
    const bar = new StatusBar();
    bar.update('info');
    bar.clear();
    expect(bar.getContent()).toBe('');
    expect(bar.render(mockStream())).toBe('');
  });

  it('getContent returns last update', () => {
    const bar = new StatusBar();
    expect(bar.getContent()).toBe('');
    bar.update('hello');
    expect(bar.getContent()).toBe('hello');
  });
});
