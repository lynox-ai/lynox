import { describe, it, expect, vi } from 'vitest';
import { InteractiveDialog } from './dialog.js';
import { EventEmitter } from 'node:events';

// === Test helpers ===

function createMockStreams() {
  const input = new EventEmitter() as NodeJS.ReadStream & EventEmitter;
  (input as unknown as Record<string, unknown>)['isTTY'] = true;
  (input as unknown as Record<string, unknown>)['setRawMode'] = vi.fn().mockReturnValue(input);
  (input as unknown as Record<string, unknown>)['resume'] = vi.fn();
  (input as unknown as Record<string, unknown>)['pause'] = vi.fn();

  const outputData: string[] = [];
  const output = {
    write: vi.fn().mockImplementation((data: string) => { outputData.push(data); return true; }),
    isTTY: true,
  } as unknown as NodeJS.WriteStream;

  return { input, output, outputData };
}

function sendKey(input: EventEmitter, key: string) {
  input.emit('data', Buffer.from(key));
}

function sendKeys(input: EventEmitter, keys: string[]) {
  for (const key of keys) {
    sendKey(input, key);
  }
}

// === Tests ===

describe('InteractiveDialog', () => {
  describe('mode detection', () => {
    it('detects select mode when options provided', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Choose:', ['A', 'B']);
      // Enter to select first option
      sendKey(input, '\r');
      return promise.then(result => {
        expect(result).toBe('A');
      });
    });

    it('detects confirm mode for [y/N] questions', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Continue? [y/N]');
      sendKey(input, 'y');
      return promise.then(result => {
        expect(result).toBe('y');
      });
    });

    it('detects confirm mode for Allow? questions', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Allow?');
      sendKey(input, 'n');
      return promise.then(result => {
        expect(result).toBe('n');
      });
    });

    it('detects freeform mode for plain questions', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('What is your name?');
      sendKeys(input, ['J', 'o', 'h', 'n', '\r']);
      return promise.then(result => {
        expect(result).toBe('John');
      });
    });
  });

  describe('select mode', () => {
    it('selects first option by default on Enter', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['Alpha', 'Beta']);
      sendKey(input, '\r');
      return promise.then(result => {
        expect(result).toBe('Alpha');
      });
    });

    it('navigates with arrow down and selects', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['Alpha', 'Beta']);
      sendKey(input, '\x1b[B'); // Arrow down
      sendKey(input, '\r');
      return promise.then(result => {
        expect(result).toBe('Beta');
      });
    });

    it('navigates with number jump', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['A', 'B', 'C']);
      sendKey(input, '3'); // Jump to C
      sendKey(input, '\r');
      return promise.then(result => {
        expect(result).toBe('C');
      });
    });

    it('arrow up does not go below 0', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['A', 'B']);
      sendKey(input, '\x1b[A'); // Arrow up (already at 0)
      sendKey(input, '\r');
      return promise.then(result => {
        expect(result).toBe('A');
      });
    });

    it('accepts freeform text input as fallback', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['A', 'B']);
      sendKeys(input, ['c', 'u', 's', 't', 'o', 'm', '\r']);
      return promise.then(result => {
        expect(result).toBe('custom');
      });
    });

    it('"Other" option activates freeform', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      // Options are ['A', 'B'] + 'Other' appended = index 2
      const promise = dialog.prompt('Pick:', ['A', 'B']);
      sendKey(input, '\x1b[B'); // Arrow down to B
      sendKey(input, '\x1b[B'); // Arrow down to Other
      sendKey(input, '\r');     // Enter on Other (activates freeform)
      sendKeys(input, ['x', 'y', 'z', '\r']); // Type and confirm
      return promise.then(result => {
        expect(result).toBe('xyz');
      });
    });

    it('ESC from Other freeform cancels dialog', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['A', 'B']);
      sendKey(input, '\x1b[B'); // Down to B
      sendKey(input, '\x1b[B'); // Down to Other
      sendKey(input, '\r');     // Enter on Other (activates freeform)
      sendKeys(input, ['x', 'y', 'z', '\r']); // Type xyz + Enter
      return promise.then(result => {
        expect(result).toBe('xyz');
      });
    });

    it('Ctrl+C returns empty string', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['A', 'B']);
      sendKey(input, '\x03'); // Ctrl+C
      return promise.then(result => {
        expect(result).toBe('');
      });
    });

    it('ESC returns empty string', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['A', 'B']);
      sendKey(input, '\x1b'); // ESC
      return promise.then(result => {
        expect(result).toBe('');
      });
    });

    it('backspace removes freeform characters', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['A']);
      sendKeys(input, ['x', 'y', '\x7f', 'z', '\r']); // type x, y, backspace, z
      return promise.then(result => {
        expect(result).toBe('xz');
      });
    });
  });

  describe('confirm mode', () => {
    it('defaults to Deny (n)', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Allow? [y/N]');
      sendKey(input, '\r'); // Enter with default (Deny)
      return promise.then(result => {
        expect(result).toBe('n');
      });
    });

    it('y key returns y', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Allow? [y/N]');
      sendKey(input, 'y');
      return promise.then(result => {
        expect(result).toBe('y');
      });
    });

    it('Y key returns y', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Allow? [y/N]');
      sendKey(input, 'Y');
      return promise.then(result => {
        expect(result).toBe('y');
      });
    });

    it('n key returns n', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Allow?');
      sendKey(input, 'N');
      return promise.then(result => {
        expect(result).toBe('n');
      });
    });

    it('left/right arrows toggle selection', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Allow? [y/N]');
      sendKey(input, '\x1b[D'); // Left arrow (toggle to Allow)
      sendKey(input, '\r');
      return promise.then(result => {
        expect(result).toBe('y');
      });
    });

    it('Ctrl+C returns n', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Allow? [y/N]');
      sendKey(input, '\x03');
      return promise.then(result => {
        expect(result).toBe('n');
      });
    });

    it('ESC returns n', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Allow? [y/N]');
      sendKey(input, '\x1b');
      return promise.then(result => {
        expect(result).toBe('n');
      });
    });
  });

  describe('freeform mode', () => {
    it('captures typed text', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Enter text:');
      sendKeys(input, ['h', 'e', 'l', 'l', 'o', '\r']);
      return promise.then(result => {
        expect(result).toBe('hello');
      });
    });

    it('backspace deletes characters', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Enter text:');
      sendKeys(input, ['a', 'b', 'c', '\x7f', '\r']); // abc + backspace
      return promise.then(result => {
        expect(result).toBe('ab');
      });
    });

    it('returns empty on Ctrl+C', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Enter text:');
      sendKey(input, '\x03');
      return promise.then(result => {
        expect(result).toBe('');
      });
    });

    it('returns empty on ESC', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Enter text:');
      sendKey(input, '\x1b');
      return promise.then(result => {
        expect(result).toBe('');
      });
    });

    it('Enter with empty text returns empty', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Enter text:');
      sendKey(input, '\r');
      return promise.then(result => {
        expect(result).toBe('');
      });
    });
  });

  describe('non-TTY fallback', () => {
    it('falls back to line-based input when not TTY', () => {
      const { input, output } = createMockStreams();
      (input as unknown as Record<string, unknown>)['isTTY'] = false;
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Question?', ['A', 'B']);
      sendKey(input, 'my answer\n');
      return promise.then(result => {
        expect(result).toBe('my answer');
      });
    });
  });

  describe('tabbedPrompt', () => {
    it('returns empty array on Ctrl+C', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.tabbedPrompt([
        { question: 'Q1?', header: 'Q1', options: ['A', 'B'] },
      ]);
      sendKey(input, '\x03');
      return promise.then(result => {
        expect(result).toEqual([]);
      });
    });

    it('returns empty array for empty questions', () => {
      const { input, output } = createMockStreams();
      (input as unknown as Record<string, unknown>)['isTTY'] = false;
      const dialog = new InteractiveDialog(input, output);

      return dialog.tabbedPrompt([]).then(result => {
        expect(result).toEqual([]);
      });
    });

    it('advances tabs on Enter with selection', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.tabbedPrompt([
        { question: 'Q1?', header: 'Q1', options: ['X', 'Y'] },
        { question: 'Q2?', header: 'Q2', options: ['M', 'N'] },
      ]);

      // Tab 1: select X (first option, default)
      sendKey(input, '\r');
      // Tab 2: select N (arrow down)
      sendKey(input, '\x1b[B');
      sendKey(input, '\r');

      return promise.then(result => {
        expect(result).toEqual(['X', 'N']);
      });
    });

    it('ESC goes back to previous tab', async () => {
      vi.useFakeTimers();
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.tabbedPrompt([
        { question: 'Q1?', header: 'T1', options: ['A', 'B'] },
        { question: 'Q2?', header: 'T2', options: ['C', 'D'] },
      ]);

      sendKey(input, '\r');     // Advance to tab 2
      sendKey(input, '\x1b');   // ESC — starts 50ms timer
      await vi.advanceTimersByTimeAsync(50); // Let ESC fire — go back to tab 1
      sendKey(input, '\x1b[B'); // Arrow down to B
      sendKey(input, '\r');     // Select B, advance to tab 2
      sendKey(input, '\r');     // Select C (first), finish
      const result = await promise;
      expect(result).toEqual(['B', 'C']);
      vi.useRealTimers();
    });

    it('ESC on first tab cancels', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.tabbedPrompt([
        { question: 'Q1?', header: 'T1', options: ['A'] },
      ]);
      sendKey(input, '\x1b');
      return promise.then(result => {
        expect(result).toEqual([]);
      });
    });

    it('non-TTY falls back to sequential prompts', () => {
      const { input, output } = createMockStreams();
      (input as unknown as Record<string, unknown>)['isTTY'] = false;
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.tabbedPrompt([
        { question: 'Q1?', header: 'T1' },
        { question: 'Q2?', header: 'T2' },
      ]);

      sendKey(input, 'answer1\n');
      // Small delay for async processing
      setTimeout(() => sendKey(input, 'answer2\n'), 10);

      return promise.then(result => {
        expect(result).toEqual(['answer1', 'answer2']);
      });
    });

    it('freeform tab requires non-empty text', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.tabbedPrompt([
        { question: 'Name?', header: 'Name' }, // No options = freeform
      ]);

      sendKey(input, '\r');     // Enter with empty — should NOT advance
      sendKeys(input, ['A', 'B', '\r']); // Type AB + Enter
      return promise.then(result => {
        expect(result).toEqual(['AB']);
      });
    });
  });

  describe('raw mode lifecycle', () => {
    it('enables raw mode on start and disables on completion', () => {
      const { input, output } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['A']);
      expect(input.setRawMode).toHaveBeenCalledWith(true);

      sendKey(input, '\r');
      return promise.then(() => {
        expect(input.setRawMode).toHaveBeenCalledWith(false);
      });
    });

    it('hides cursor during select mode', () => {
      const { input, output, outputData } = createMockStreams();
      const dialog = new InteractiveDialog(input, output);

      const promise = dialog.prompt('Pick:', ['A']);
      expect(outputData.some(d => d.includes('\x1b[?25l'))).toBe(true);

      sendKey(input, '\r');
      return promise.then(() => {
        expect(outputData.some(d => d.includes('\x1b[?25h'))).toBe(true);
      });
    });
  });
});
