import { describe, it, expect } from 'vitest';
import { nextOccurrence, isValidCron } from './cron-parser.js';

describe('cron-parser', () => {
  // -----------------------------------------------------------------------
  // isValidCron
  // -----------------------------------------------------------------------

  describe('isValidCron', () => {
    it('accepts standard 5-field cron', () => {
      expect(isValidCron('0 8 * * *')).toBe(true);
    });

    it('accepts shorthand intervals', () => {
      expect(isValidCron('30s')).toBe(true);
      expect(isValidCron('5m')).toBe(true);
      expect(isValidCron('1h')).toBe(true);
      expect(isValidCron('1d')).toBe(true);
    });

    it('accepts step expressions', () => {
      expect(isValidCron('*/15 * * * *')).toBe(true);
    });

    it('accepts range expressions', () => {
      expect(isValidCron('0 9 * * 1-5')).toBe(true);
    });

    it('accepts list expressions', () => {
      expect(isValidCron('0 9 1,15 * *')).toBe(true);
    });

    it('rejects empty string', () => {
      expect(isValidCron('')).toBe(false);
    });

    it('rejects random text', () => {
      expect(isValidCron('not-a-cron')).toBe(false);
    });

    it('rejects too few fields', () => {
      expect(isValidCron('0 8 *')).toBe(false);
    });

    it('rejects out-of-range values', () => {
      expect(isValidCron('60 * * * *')).toBe(false);  // minute max 59
      expect(isValidCron('0 25 * * *')).toBe(false);  // hour max 23
    });

    it('rejects zero interval', () => {
      expect(isValidCron('0m')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // nextOccurrence — shorthand intervals
  // -----------------------------------------------------------------------

  describe('nextOccurrence — shorthand intervals', () => {
    const base = new Date('2026-03-25T10:00:00.000Z');

    it('30m adds 30 minutes', () => {
      const next = nextOccurrence('30m', base);
      expect(next.getTime()).toBe(base.getTime() + 30 * 60_000);
    });

    it('1h adds 1 hour', () => {
      const next = nextOccurrence('1h', base);
      expect(next.getTime()).toBe(base.getTime() + 3_600_000);
    });

    it('1d adds 24 hours', () => {
      const next = nextOccurrence('1d', base);
      expect(next.getTime()).toBe(base.getTime() + 86_400_000);
    });

    it('30s adds 30 seconds', () => {
      const next = nextOccurrence('30s', base);
      expect(next.getTime()).toBe(base.getTime() + 30_000);
    });
  });

  // -----------------------------------------------------------------------
  // nextOccurrence — standard cron
  // -----------------------------------------------------------------------

  describe('nextOccurrence — standard cron', () => {
    it('0 8 * * * — daily at 08:00 (from 07:30)', () => {
      const after = new Date('2026-03-25T07:30:00.000Z');
      const next = nextOccurrence('0 8 * * *', after);
      expect(next.getUTCHours()).toBe(8);
      expect(next.getUTCMinutes()).toBe(0);
      expect(next.getUTCDate()).toBe(25);
    });

    it('0 8 * * * — rolls to next day when past 08:00', () => {
      const after = new Date('2026-03-25T09:00:00.000Z');
      const next = nextOccurrence('0 8 * * *', after);
      expect(next.getUTCHours()).toBe(8);
      expect(next.getUTCMinutes()).toBe(0);
      expect(next.getUTCDate()).toBe(26);
    });

    it('*/15 * * * * — every 15 minutes', () => {
      const after = new Date('2026-03-25T10:03:00.000Z');
      const next = nextOccurrence('*/15 * * * *', after);
      expect(next.getUTCHours()).toBe(10);
      expect(next.getUTCMinutes()).toBe(15);
    });

    it('0 9 * * 1-5 — weekdays at 9am (skips weekend)', () => {
      // 2026-03-28 is Saturday
      const saturday = new Date('2026-03-28T10:00:00.000Z');
      const next = nextOccurrence('0 9 * * 1-5', saturday);
      // Should land on Monday 2026-03-30
      expect(next.getUTCDay()).toBeGreaterThanOrEqual(1);
      expect(next.getUTCDay()).toBeLessThanOrEqual(5);
      expect(next.getUTCHours()).toBe(9);
      expect(next.getUTCMinutes()).toBe(0);
    });

    it('0 0 1 * * — first of every month at midnight', () => {
      const after = new Date('2026-03-15T12:00:00.000Z');
      const next = nextOccurrence('0 0 1 * *', after);
      expect(next.getUTCDate()).toBe(1);
      expect(next.getUTCHours()).toBe(0);
      expect(next.getUTCMinutes()).toBe(0);
      expect(next.getUTCMonth()).toBe(3); // April (0-indexed)
    });

    it('list expression: 0 9 1,15 * * — 1st and 15th at 9am', () => {
      const after = new Date('2026-03-02T00:00:00.000Z');
      const next = nextOccurrence('0 9 1,15 * *', after);
      // Next matching day-of-month is 15 (must also match day-of-week *)
      expect(next.getUTCDate()).toBe(15);
      expect(next.getUTCHours()).toBe(9);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('midnight rollover: 0 0 * * * after 23:30', () => {
      const after = new Date('2026-03-25T23:30:00.000Z');
      const next = nextOccurrence('0 0 * * *', after);
      expect(next.getUTCDate()).toBe(26);
      expect(next.getUTCHours()).toBe(0);
      expect(next.getUTCMinutes()).toBe(0);
    });

    it('month boundary: rolls from March to April', () => {
      const after = new Date('2026-03-31T23:59:00.000Z');
      const next = nextOccurrence('0 8 * * *', after);
      expect(next.getUTCMonth()).toBe(3); // April
      expect(next.getUTCDate()).toBe(1);
      expect(next.getUTCHours()).toBe(8);
    });

    it('defaults to now when no after date is provided', () => {
      const before = Date.now();
      const next = nextOccurrence('* * * * *');
      expect(next.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('throws on impossible expression (no match in 366 days)', () => {
      // Day 31 in February only — but also month=2, dow=* — Feb 31 never exists
      expect(() => nextOccurrence('0 0 31 2 *')).toThrow('No matching occurrence');
    });
  });

  // -----------------------------------------------------------------------
  // Invalid expressions in nextOccurrence
  // -----------------------------------------------------------------------

  describe('nextOccurrence — invalid expressions', () => {
    it('throws on empty string', () => {
      expect(() => nextOccurrence('')).toThrow();
    });

    it('throws on malformed expression', () => {
      expect(() => nextOccurrence('abc')).toThrow();
    });
  });
});
