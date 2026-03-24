import { describe, it, expect, afterEach } from 'vitest';
import { registerCommand, registerValidMode, getValidModes } from './index.js';

describe('CLI Extension Points', () => {
  describe('registerValidMode', () => {
    it('extends the valid modes set', () => {
      const before = getValidModes();
      expect(before).not.toContain('custom-agent');

      registerValidMode('custom-agent');
      const after = getValidModes();
      expect(after).toContain('custom-agent');
    });

    it('includes all built-in modes', () => {
      const modes = getValidModes();
      expect(modes).toContain('interactive');
      expect(modes).toContain('autopilot');
    });

    it('does not duplicate existing modes', () => {
      registerValidMode('interactive');
      const modes = getValidModes();
      const count = modes.filter(m => m === 'interactive').length;
      expect(count).toBe(1);
    });
  });

  describe('registerCommand', () => {
    it('exports registerCommand function', () => {
      expect(typeof registerCommand).toBe('function');
    });

    it('accepts name with or without slash prefix', () => {
      // Just verify no error is thrown
      registerCommand('/test-cmd', async () => true);
      registerCommand('test-cmd2', async () => true);
    });
  });
});
