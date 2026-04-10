import { describe, it, expect, vi } from 'vitest';
import { SessionStore } from './session-store.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';

let sessionCounter = 0;

function makeMockSession(): Session {
  sessionCounter++;
  return {
    sessionId: `mock-session-${sessionCounter}`,
    _isMockSession: true,
  } as unknown as Session;
}

function makeMockEngine(): Engine {
  return {
    createSession: vi.fn().mockImplementation(() => makeMockSession()),
    getThreadStore: vi.fn().mockReturnValue(null),
  } as unknown as Engine;
}

describe('SessionStore', () => {
  describe('getOrCreate', () => {
    it('creates a new session for unknown session ID', () => {
      const store = new SessionStore();
      const engine = makeMockEngine();
      const session = store.getOrCreate('session-1', engine);
      expect(session).toBeDefined();
      expect((session as unknown as { _isMockSession: boolean })._isMockSession).toBe(true);
      expect(engine.createSession).toHaveBeenCalledTimes(1);
    });

    it('returns the same session for the same session ID', () => {
      const store = new SessionStore();
      const engine = makeMockEngine();
      const session1 = store.getOrCreate('session-1', engine);
      const session2 = store.getOrCreate('session-1', engine);
      expect(session1).toBe(session2);
      // createSession should only be called once
      expect(engine.createSession).toHaveBeenCalledTimes(1);
    });

    it('does not create a new session on second call with same ID', () => {
      const store = new SessionStore();
      const engine = makeMockEngine();
      const session1 = store.getOrCreate('s1', engine, { briefing: 'first' });
      const session2 = store.getOrCreate('s1', engine, { briefing: 'second' });
      expect(session1).toBe(session2);
      // Opts from second call are ignored since session already exists
      expect(engine.createSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset', () => {
    it('removes session so next getOrCreate creates fresh session', () => {
      const store = new SessionStore();
      const engine = makeMockEngine();
      const session1 = store.getOrCreate('session-1', engine);
      store.reset('session-1');
      const session2 = store.getOrCreate('session-1', engine);
      expect(session2).not.toBe(session1);
      expect(engine.createSession).toHaveBeenCalledTimes(2);
    });

    it('does not affect other sessions', () => {
      const store = new SessionStore();
      const engine = makeMockEngine();
      store.getOrCreate('s1', engine);
      const session2 = store.getOrCreate('s2', engine);
      store.reset('s1');
      const session2Again = store.getOrCreate('s2', engine);
      expect(session2Again).toBe(session2);
    });

    it('is no-op for unknown session ID', () => {
      const store = new SessionStore();
      // Should not throw
      store.reset('nonexistent');
    });
  });

  describe('different session IDs', () => {
    it('get different sessions', () => {
      const store = new SessionStore();
      const engine = makeMockEngine();
      const sessionA = store.getOrCreate('session-a', engine);
      const sessionB = store.getOrCreate('session-b', engine);
      expect(sessionA).not.toBe(sessionB);
    });
  });

  describe('eviction', () => {
    it('evicts idle sessions after maxIdleMs', () => {
      vi.useFakeTimers();
      const store = new SessionStore();
      const engine = makeMockEngine();

      store.getOrCreate('idle-1', engine);
      store.getOrCreate('idle-2', engine);
      expect(store.size).toBe(2);

      // Start eviction with 10s idle, 5s interval
      store.startEviction(10_000, 5_000);

      // Advance past idle threshold + one interval
      vi.advanceTimersByTime(15_000);
      expect(store.size).toBe(0);
      expect(store.get('idle-1')).toBeUndefined();
      expect(store.get('idle-2')).toBeUndefined();

      store.stopEviction();
      vi.useRealTimers();
    });

    it('keeps recently accessed sessions', () => {
      vi.useFakeTimers();
      const store = new SessionStore();
      const engine = makeMockEngine();

      store.getOrCreate('active', engine);
      store.getOrCreate('stale', engine);
      store.startEviction(10_000, 5_000);

      // After 8s, touch 'active' — 'stale' untouched
      vi.advanceTimersByTime(8_000);
      store.get('active');

      // At 15s: 'stale' is 15s idle (>10s), 'active' is 7s idle (<10s)
      vi.advanceTimersByTime(7_000);
      expect(store.size).toBe(1);
      expect(store.get('active')).toBeDefined();
      expect(store.get('stale')).toBeUndefined();

      store.stopEviction();
      vi.useRealTimers();
    });

    it('does not evict sessions that are actively running', () => {
      vi.useFakeTimers();
      const store = new SessionStore();
      const engine = makeMockEngine();

      store.getOrCreate('running', engine);
      store.setRunningCheck((id) => id === 'running');
      store.startEviction(10_000, 5_000);

      vi.advanceTimersByTime(15_000);
      // Should still be present because it's running
      expect(store.size).toBe(1);

      store.stopEviction();
      vi.useRealTimers();
    });

    it('startEviction is idempotent', () => {
      const store = new SessionStore();
      store.startEviction(10_000, 5_000);
      store.startEviction(10_000, 5_000); // no-op
      store.stopEviction();
    });
  });

  describe('get', () => {
    it('returns undefined for unknown session ID', () => {
      const store = new SessionStore();
      expect(store.get('no-such-session')).toBeUndefined();
    });

    it('returns the session for an existing session', () => {
      const store = new SessionStore();
      const engine = makeMockEngine();
      const session = store.getOrCreate('session-x', engine);
      expect(store.get('session-x')).toBe(session);
    });

    it('returns undefined after reset', () => {
      const store = new SessionStore();
      const engine = makeMockEngine();
      store.getOrCreate('session-y', engine);
      store.reset('session-y');
      expect(store.get('session-y')).toBeUndefined();
    });
  });
});
