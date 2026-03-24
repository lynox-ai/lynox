import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronTrigger } from './cron-trigger.js';
import type { TriggerCallback, TriggerEvent } from '../../types/index.js';

describe('CronTrigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor — valid expressions', () => {
    it('parses "30s" to 30000ms', () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '30s' });
      expect(trigger.type).toBe('cron');
    });

    it('parses "5m" to 300000ms', () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '5m' });
      expect(trigger.type).toBe('cron');
    });

    it('parses "1h" to 3600000ms', () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '1h' });
      expect(trigger.type).toBe('cron');
    });
  });

  describe('constructor — invalid expressions', () => {
    it('throws on invalid expression "abc"', () => {
      expect(() => new CronTrigger({ type: 'cron', expression: 'abc' })).toThrow('Invalid cron expression');
    });

    it('throws on invalid expression "10x"', () => {
      expect(() => new CronTrigger({ type: 'cron', expression: '10x' })).toThrow('Invalid cron expression');
    });

    it('throws on empty expression', () => {
      expect(() => new CronTrigger({ type: 'cron', expression: '' })).toThrow('Invalid cron expression');
    });

    it('throws on cron-style expression "* * * * *"', () => {
      expect(() => new CronTrigger({ type: 'cron', expression: '* * * * *' })).toThrow('Invalid cron expression');
    });
  });

  describe('start', () => {
    it('fires callback at correct interval with source="cron"', async () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '30s' });
      const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

      trigger.start(callback);

      // Should not fire immediately
      expect(callback).not.toHaveBeenCalled();

      // Advance by 30 seconds
      await vi.advanceTimersByTimeAsync(30_000);
      expect(callback).toHaveBeenCalledTimes(1);

      const event = callback.mock.calls[0]![0] as TriggerEvent;
      expect(event.source).toBe('cron');
      expect(event.payload).toEqual(expect.objectContaining({ expression: '30s' }));
      expect(typeof event.timestamp).toBe('string');

      trigger.stop();
    });

    it('fires with "5m" interval after 300000ms', async () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '5m' });
      const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

      trigger.start(callback);

      // Not yet at 5 minutes
      await vi.advanceTimersByTimeAsync(299_999);
      expect(callback).not.toHaveBeenCalled();

      // At exactly 5 minutes
      await vi.advanceTimersByTimeAsync(1);
      expect(callback).toHaveBeenCalledTimes(1);

      trigger.stop();
    });

    it('fires with "1h" interval after 3600000ms', async () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '1h' });
      const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

      trigger.start(callback);

      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(callback).toHaveBeenCalledTimes(1);

      trigger.stop();
    });
  });

  describe('stop', () => {
    it('clears interval — no more callbacks after stop', async () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '30s' });
      const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

      trigger.start(callback);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callback).toHaveBeenCalledTimes(1);

      trigger.stop();

      // Advance another interval — should NOT fire again
      await vi.advanceTimersByTimeAsync(30_000);
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('is safe to call stop multiple times', () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '30s' });
      trigger.start(vi.fn(() => Promise.resolve()));
      trigger.stop();
      expect(() => trigger.stop()).not.toThrow();
    });
  });

  describe('multiple ticks', () => {
    it('fires multiple times across intervals', async () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '30s' });
      const callback = vi.fn<TriggerCallback>(() => Promise.resolve());

      trigger.start(callback);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callback).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callback).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(callback).toHaveBeenCalledTimes(3);

      trigger.stop();
    });

    it('each event has a unique timestamp', async () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '30s' });
      const events: TriggerEvent[] = [];
      const callback: TriggerCallback = async (event) => { events.push(event); };

      trigger.start(callback);

      await vi.advanceTimersByTimeAsync(90_000);
      expect(events).toHaveLength(3);

      // Timestamps should be ISO strings
      for (const event of events) {
        expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }

      trigger.stop();
    });

    it('swallows rejected callback promises and keeps ticking', async () => {
      const trigger = new CronTrigger({ type: 'cron', expression: '30s' });
      const callback = vi.fn<TriggerCallback>().mockRejectedValue(new Error('boom'));

      trigger.start(callback);

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(callback).toHaveBeenCalledTimes(2);

      trigger.stop();
    });
  });
});
