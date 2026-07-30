import { describe, it, expect, vi } from 'vitest';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { SessionStore, buildResumeContext } from './session-store.js';
import type { Engine } from './engine.js';
import type { Session } from './session.js';
import type { ThreadRecord } from './thread-store.js';

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

    // Regression: resuming a thread persisted BEFORE the 2026-05-29 tier rename
    // stored a legacy Anthropic-brand `model_tier` ('sonnet'/'opus'/'haiku').
    // An un-normalized cast let those reach MODEL_MAP[tier] → undefined →
    // `normalizeModelId(undefined).replace` → 500 on POST /api/sessions, so
    // clicking a pre-rename thread showed an empty chat until a full refresh.
    // The whole resume branch was previously untested (getThreadStore mocked
    // to null), which is exactly why the reset-to-clean QA fleet never hit it.
    it('normalizes a legacy persisted model_tier on resume', () => {
      const store = new SessionStore();
      const threadStore = {
        getThread: vi.fn().mockReturnValue({
          id: 'thread-legacy',
          title: 't',
          model_tier: 'sonnet', // legacy alias for 'balanced'
          context_id: null,
          summary: null,
          skip_extraction: 0,
        }),
        getMessages: vi.fn().mockReturnValue([]),
      };
      const engine = {
        createSession: vi.fn().mockImplementation(() => makeMockSession()),
        getThreadStore: vi.fn().mockReturnValue(threadStore),
      } as unknown as Engine;

      expect(() => store.getOrCreate('thread-legacy', engine)).not.toThrow();
      expect(engine.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'thread-legacy', model: 'balanced' }),
      );
    });

    it('passes a canonical tier through unchanged on resume', () => {
      const store = new SessionStore();
      const threadStore = {
        getThread: vi.fn().mockReturnValue({
          id: 'thread-canonical',
          title: 't',
          model_tier: 'deep',
          context_id: null,
          summary: null,
          skip_extraction: 0,
        }),
        getMessages: vi.fn().mockReturnValue([]),
      };
      const engine = {
        createSession: vi.fn().mockImplementation(() => makeMockSession()),
        getThreadStore: vi.fn().mockReturnValue(threadStore),
      } as unknown as Engine;

      store.getOrCreate('thread-canonical', engine);
      expect(engine.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'deep' }),
      );
    });
  });

  describe('resume summary (F5/F6)', () => {
    // Resume of a long thread (> VERBATIM_THRESHOLD=80, no stored summary) fires
    // the fire-and-forget generateThreadSummary. Build an engine whose
    // createSession returns a session with a controllable `run` (the summary run)
    // + a `loadMessages` (the resumed session), and a threadStore we can inspect.
    function longThreadEngine(runImpl: () => Promise<string>): {
      engine: Engine;
      updateThread: ReturnType<typeof vi.fn>;
    } {
      const updateThread = vi.fn();
      const records = Array.from({ length: 90 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content_json: JSON.stringify(`msg ${i}`),
      }));
      const threadStore = {
        getThread: vi.fn().mockReturnValue({
          id: 'long', title: 't', model_tier: 'balanced', context_id: null,
          summary: null, skip_extraction: 0,
        }),
        getMessages: vi.fn().mockReturnValue(records),
        updateThread,
      };
      const engine = {
        createSession: vi.fn().mockImplementation(() => ({
          loadMessages: vi.fn(),
          run: vi.fn().mockImplementation(runImpl),
        })),
        getThreadStore: vi.fn().mockReturnValue(threadStore),
        getSecretStore: vi.fn().mockReturnValue({
          maskSecrets: (s: string) => s.replace(/sk-\w+/g, '«masked»'),
        }),
      } as unknown as Engine;
      return { engine, updateThread };
    }

    it('F6: masks a secret the summarizer echoed before persisting threads.summary', async () => {
      const { engine, updateThread } = longThreadEngine(async () => 'recap: the key is sk-LEAK42 and we shipped');
      new SessionStore().getOrCreate('long', engine);
      await vi.waitFor(() => expect(updateThread).toHaveBeenCalled());
      const summaryArg = (updateThread.mock.calls.at(-1)?.[1] as { summary?: string })?.summary ?? '';
      expect(summaryArg).toContain('«masked»');
      expect(summaryArg).not.toContain('sk-LEAK42');
    });

    it('F5: does NOT persist an empty/blocked summary (guard-block string never becomes the authoritative summary)', async () => {
      // An internal-run budget block THROWS (mirrored here as a rejection); the
      // outer try/catch swallows it → nothing persisted, retried next resume.
      const { engine, updateThread } = longThreadEngine(async () => { throw new Error('Daily spending cap reached'); });
      new SessionStore().getOrCreate('long', engine);
      await new Promise(r => setTimeout(r, 20)); // let the fire-and-forget settle
      expect(updateThread).not.toHaveBeenCalled();
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

describe('buildResumeContext (Slice B — delta-since-summary resume)', () => {
  function mkThread(summary: string | null, summary_up_to: number): ThreadRecord {
    return { summary, summary_up_to } as unknown as ThreadRecord;
  }
  function mkMessages(n: number): BetaMessageParam[] {
    return Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `msg-${i}`,
    }));
  }

  it('loads [summary + every message since summary_up_to], closing the gap the fixed recent-window left', () => {
    const messages = mkMessages(100);
    // Summary covers up to index 50. The OLD fixed last-40 window started at
    // index 60 and silently DROPPED messages 50–59; the delta slice includes them.
    const ctx = buildResumeContext(mkThread('SUMMARY', 50), messages);
    expect(ctx[1]).toMatchObject({ role: 'assistant', content: 'SUMMARY' });
    const recent = ctx.slice(2);
    expect(recent).toHaveLength(50); // messages 50..99, not just the last 40
    expect(recent[0]).toMatchObject({ content: 'msg-50' }); // the gap-closer is present
    expect(recent.at(-1)).toMatchObject({ content: 'msg-99' });
  });

  it('caps the post-summary tail at MAX_RESUME_DELTA so a pathological long tail cannot blow up the payload', () => {
    const messages = mkMessages(500);
    const ctx = buildResumeContext(mkThread('SUMMARY', 10), messages); // raw delta would be 490
    const recent = ctx.slice(2);
    expect(recent).toHaveLength(120); // capped, not 490
    expect(recent[0]).toMatchObject({ content: 'msg-380' }); // 500 - 120
    expect(recent.at(-1)).toMatchObject({ content: 'msg-499' });
  });

  it('falls back to the fixed recent window for a legacy summary with an unset (0) summary_up_to', () => {
    const messages = mkMessages(100);
    const ctx = buildResumeContext(mkThread('LEGACY SUMMARY', 0), messages);
    const recent = ctx.slice(2);
    expect(recent).toHaveLength(40); // pre-Slice-B behavior preserved
    expect(recent[0]).toMatchObject({ content: 'msg-60' });
  });

  it('uses the placeholder path (unchanged) when no summary exists', () => {
    const messages = mkMessages(100);
    const ctx = buildResumeContext(mkThread(null, 0), messages);
    expect(JSON.stringify(ctx[0]?.content)).toContain('Resuming conversation');
    expect(JSON.stringify(ctx[0]?.content)).toContain('60'); // dropped count = 100 - 40
    expect(ctx.slice(2)).toHaveLength(40);
  });
});
