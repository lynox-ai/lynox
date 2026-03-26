import { describe, it, expect } from 'vitest';
import {
  wordWrap,
  renderBanner,
  renderToolCall,
  renderToolResult,
  renderSpawn,
  renderError,
  renderThinking,
  renderPermission,
  renderTable,
  RESET, BOLD, DIM, RED, GREEN, MAGENTA, BLUE, GRAY,
} from './ui.js';

describe('wordWrap', () => {
  it('wraps text at specified width', () => {
    const lines = wordWrap('one two three four five', 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(10);
    }
  });

  it('returns short text unchanged', () => {
    expect(wordWrap('short', 80)).toEqual(['short']);
  });

  it('returns [""] for empty string', () => {
    expect(wordWrap('', 80)).toEqual(['']);
  });

  it('keeps long word intact when exceeding width', () => {
    const lines = wordWrap('superlongword', 5);
    expect(lines).toEqual(['superlongword']);
  });
});

describe('renderBanner', () => {
  const banner = renderBanner('opus', 'adaptive', 'high', 'loaded', 2, 10, '1.0.0-rc.1');

  it('contains LYNOX ASCII art', () => {
    // Each char is individually color-wrapped — strip ANSI to check
    const plain = banner.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('███');
  });

  it('contains model name', () => {
    expect(banner).toContain('opus');
  });

  it('contains tool count', () => {
    expect(banner).toContain('10');
  });

  it('contains version string', () => {
    expect(banner).toContain('v1.0.0-rc.1');
  });

  it('shows memory status', () => {
    const b = renderBanner('opus', 'adaptive', 'high', 'none', 0, 5);
    expect(b).toContain('none');
  });
});

describe('renderToolCall', () => {
  it('extracts command from input', () => {
    const result = renderToolCall('bash', { command: 'ls -la' });
    expect(result).toContain('Running command');
    expect(result).toContain('ls -la');
  });

  it('extracts question from input', () => {
    const result = renderToolCall('ask_user', { question: 'Continue?' });
    expect(result).toContain('Continue?');
  });

  it('extracts path from input', () => {
    const result = renderToolCall('read_file', { path: '/tmp/file.ts' });
    expect(result).toContain('/tmp/file.ts');
  });

  it('extracts query from input', () => {
    const result = renderToolCall('search', { query: 'find me' });
    expect(result).toContain('find me');
  });

  it('falls back to first key for unknown fields', () => {
    const result = renderToolCall('custom', { content: 'hello world' });
    expect(result).toContain('content: hello world');
  });

  it('truncates detail at 80 chars', () => {
    const longCmd = 'a'.repeat(100);
    const result = renderToolCall('bash', { command: longCmd });
    expect(result).toContain('...');
    // The visible detail portion should be truncated
    expect(result).not.toContain('a'.repeat(100));
  });

  it('contains lightning bolt emoji', () => {
    const result = renderToolCall('test', {});
    expect(result).toContain('⚡');
  });

  it('handles null input', () => {
    const result = renderToolCall('test', null);
    expect(result).toContain('test');
  });

  it('handles empty object input', () => {
    const result = renderToolCall('test', {});
    expect(result).toContain('test');
    expect(result).not.toContain('───');
  });
});

describe('renderToolResult', () => {
  it('contains checkmark and tool name', () => {
    const result = renderToolResult('bash');
    expect(result).toContain('✓');
    expect(result).toContain('Running command');
  });
});

describe('renderSpawn', () => {
  it('lists agent names', () => {
    const result = renderSpawn(['alpha', 'beta']);
    expect(result).toContain('alpha');
    expect(result).toContain('beta');
    expect(result).toContain('Delegating to');
  });
});

describe('renderError', () => {
  it('contains error marker and message', () => {
    const result = renderError('something failed');
    expect(result).toContain('✗');
    expect(result).toContain('something failed');
  });
});

describe('renderThinking', () => {
  it('wraps text in dim gray', () => {
    const result = renderThinking('pondering...', false);
    expect(result).toContain('pondering...');
    expect(result).toContain(GRAY);
    expect(result).toContain(DIM);
  });

  it('adds thinking label on start', () => {
    const result = renderThinking('pondering...', true);
    expect(result).toContain('👾 Thinking...');
    expect(result).toContain('pondering...');
  });
});

describe('renderPermission', () => {
  it('contains description in bold magenta', () => {
    const result = renderPermission('Allow write?');
    expect(result).toContain('Allow write?');
    expect(result).toContain(MAGENTA);
    expect(result).toContain(BOLD);
  });
});

describe('renderTable', () => {
  it('renders headers and rows', () => {
    const result = renderTable(['Name', 'Value'], [['foo', 'bar']]);
    expect(result).toContain('Name');
    expect(result).toContain('Value');
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });

  it('uses table box-drawing characters', () => {
    const result = renderTable(['A'], [['1']]);
    expect(result).toContain('┌');
    expect(result).toContain('└');
    expect(result).toContain('│');
  });

  it('handles empty rows', () => {
    const result = renderTable(['H1', 'H2'], []);
    expect(result).toContain('H1');
    expect(result).toContain('H2');
  });

  it('pads missing cells', () => {
    const result = renderTable(['A', 'B', 'C'], [['x']]);
    expect(result).toContain('x');
    // Should not throw
  });
});

describe('color constants', () => {
  it('exports correct ANSI codes', () => {
    expect(RESET).toBe('\x1b[0m');
    expect(BOLD).toBe('\x1b[1m');
    expect(DIM).toBe('\x1b[2m');
    expect(RED).toBe('\x1b[31m');
    expect(GREEN).toBe('\x1b[32m');
    expect(MAGENTA).toBe('\x1b[35m');
    expect(BLUE).toBe('\x1b[34m');
    expect(GRAY).toBe('\x1b[90m');
  });
});
