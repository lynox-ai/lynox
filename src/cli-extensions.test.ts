import { describe, it, expect } from 'vitest';
import { registerCommand } from './index.js';

describe('CLI Extension Points', () => {
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
