import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FooterBar } from './footer.js';

describe('FooterBar', () => {
  let footer: FooterBar;

  beforeEach(() => {
    footer = new FooterBar();
  });

  describe('activate() + isActivated()', () => {
    it('activates when stdout is a TTY', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      footer.activate();
      expect(footer.isActivated()).toBe(true);
    });

    it('does not activate when stdout is not a TTY', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      footer.activate();
      expect(footer.isActivated()).toBe(false);
    });
  });

  describe('deactivate()', () => {
    it('sets inactive after being activated', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      footer.activate();
      expect(footer.isActivated()).toBe(true);
      footer.deactivate();
      expect(footer.isActivated()).toBe(false);
    });
  });

  describe('render()', () => {
    it('returns empty string when inactive', () => {
      footer.setStatus('some status');
      expect(footer.render()).toBe('');
    });

    it('returns empty string when active but no status set', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      footer.activate();
      expect(footer.render()).toBe('');
    });

    it('returns formatted line with right-aligned status', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
      footer.activate();
      footer.setStatus('tokens: 1234');

      const result = footer.render();

      // Should contain the status text
      expect(result).toContain('tokens: 1234');
      // Should start with line-fill separator
      expect(result).toMatch(/^.*─/);
      // Should end with newline
      expect(result).toMatch(/\n$/);
      // Should contain ANSI reset codes
      expect(result).toContain('\x1b[0m');
    });
  });

  describe('setStatus()', () => {
    it('updates the right text used in render', () => {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
      footer.activate();

      footer.setStatus('first');
      const r1 = footer.render();
      expect(r1).toContain('first');

      footer.setStatus('second');
      const r2 = footer.render();
      expect(r2).toContain('second');
      expect(r2).not.toContain('first');
    });
  });
});
