/**
 * Prompt-cache stability guard.
 *
 * Prompt caching is the single biggest cost lever for a long chat: with a
 * stable cacheable prefix, turn N+1 reads the whole conversation back from
 * cache and pays full price only for the new turn. The dominant silent cost
 * regression (rafael 2026-06-05, ~$18/day) was a per-turn-volatile block
 * (retrieved knowledge) injected into the SYSTEM prefix — i.e. BEFORE the
 * conversation. Because Anthropic caching is a *prefix* cache, that re-broke
 * the cache for the entire history on every turn, re-billing it at full price.
 *
 * These tests lock the two invariants that keep the prefix cacheable:
 *   1. The system prompt is byte-stable regardless of per-turn grounding.
 *   2. Per-turn grounding rides as an UNCACHED TAIL on the current user turn,
 *      never mutating the persisted history (so the next turn re-sends a
 *      byte-identical prefix → cache hit).
 * Plus the warm-cache-miss detector predicate that catches a future break live.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic { beta = { messages: { stream: vi.fn() } }; }
  class APIError extends Error {}
  return { default: MockAnthropic, APIError };
});
vi.mock('./stream.js', () => ({ StreamProcessor: vi.fn() }));
vi.mock('../tools/permission-guard.js', () => ({ isDangerous: vi.fn().mockReturnValue(null), isDangerousDetailed: vi.fn().mockReturnValue(null) }));
vi.mock('./observability.js', () => ({
  channels: { cacheHealth: { publish: vi.fn() }, contentTruncation: { hasSubscribers: false, publish: vi.fn() } },
  measureTool: vi.fn().mockReturnValue({ end: () => 0 }),
}));

import { Agent } from './agent.js';

interface AgentInternals {
  _buildSystemPrompt(): Array<{ type: string; text: string; cache_control?: unknown }>;
  _buildEphemeralContextBlocks(): Array<{ type: string; text: string }>;
  _applyOutboundCaching(
    messages: Array<{ role: string; content: unknown }>,
    ephemeral: Array<{ type: string; text: string }>,
  ): Array<{ role: string; content: unknown }>;
}

function makeAgent(systemPrompt = 'STATIC SYSTEM PROMPT — load-bearing, must never vary per turn.') {
  const agent = new Agent({ name: 'test', model: 'claude-sonnet-4-6', systemPrompt });
  return agent as unknown as Agent & AgentInternals;
}

describe('prompt-cache stability', () => {
  describe('system prefix is byte-stable across per-turn grounding', () => {
    it('the system blocks do NOT vary when knowledge / briefing change', () => {
      const agent = makeAgent();

      agent.setKnowledgeContext('memories retrieved for query A');
      const sys1 = JSON.stringify(agent._buildSystemPrompt());

      // A different turn: different query → different retrieved memories, plus a
      // one-time briefing. NEITHER may leak into the cached system prefix.
      agent.setKnowledgeContext('totally different memories retrieved for query B');
      agent.setBriefing('<session_briefing>run-history briefing</session_briefing>');
      const sys2 = JSON.stringify(agent._buildSystemPrompt());

      expect(sys2).toEqual(sys1);
    });

    it('retrieved knowledge never appears in the system prefix', () => {
      const agent = makeAgent();
      agent.setKnowledgeContext('SENTINEL_SECRET_MEMORY_42');
      const sys = JSON.stringify(agent._buildSystemPrompt());
      expect(sys).not.toContain('SENTINEL_SECRET_MEMORY_42');
    });

    it('grounding rides in the ephemeral tail, with its anti-injection wrapper', () => {
      const agent = makeAgent();
      agent.setKnowledgeContext('SENTINEL_SECRET_MEMORY_42');
      const eph = JSON.stringify(agent._buildEphemeralContextBlocks());
      expect(eph).toContain('SENTINEL_SECRET_MEMORY_42');
      expect(eph).toContain('retrieved_context'); // boundary preserved
    });
  });

  describe('_applyOutboundCaching keeps the persisted prefix byte-stable', () => {
    it('does not mutate the input messages, and tails the grounding uncached', () => {
      const agent = makeAgent();
      const messages = [{ role: 'user', content: 'hello' }];
      const eph = [{ type: 'text', text: '<retrieved_context>K</retrieved_context>' }];

      const out = agent._applyOutboundCaching(messages, eph);

      // Input untouched (persisted history must stay plain).
      expect(messages[0]!.content).toBe('hello');

      const content = out[0]!.content as Array<{ text: string; cache_control?: unknown }>;
      expect(Array.isArray(content)).toBe(true);
      // [0] = the persisted block carries the cache breakpoint…
      expect(content[0]!.text).toBe('hello');
      expect(content[0]!.cache_control).toBeDefined();
      // [1] = grounding tail AFTER the breakpoint, uncached.
      expect(content[1]!.text).toContain('K');
      expect(content[1]!.cache_control).toBeUndefined();
    });

    it('the cached prefix of turn N+1 matches turn N (grounding never poisons it)', () => {
      const agent = makeAgent();

      // Turn 1: history = [u1], grounding K1.
      agent._applyOutboundCaching([{ role: 'user', content: 'q1' }], [{ type: 'text', text: 'K1' }]);

      // Turn 2: history = [u1 (PLAIN, persisted), a1, u2], grounding K2.
      const turn2 = agent._applyOutboundCaching(
        [
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'q2' },
        ],
        [{ type: 'text', text: 'K2' }],
      );

      // The earlier turns must be re-sent byte-identical — q1 plain, no
      // grounding tail, no cache_control — so they hit turn-1's cache.
      expect(turn2[0]).toEqual({ role: 'user', content: 'q1' });
      expect(turn2[1]).toEqual({ role: 'assistant', content: 'a1' });
      // Only the NEW user turn carries the breakpoint + this turn's grounding.
      const last = turn2[2]!.content as Array<{ text: string; cache_control?: unknown }>;
      expect(last[0]!.cache_control).toBeDefined();
      expect(last[1]!.text).toBe('K2');
    });

    it('returns history untouched when there is no grounding (breakpoint only)', () => {
      const agent = makeAgent();
      const out = agent._applyOutboundCaching([{ role: 'user', content: 'just a question' }], []);
      const content = out[0]!.content as Array<{ text: string; cache_control?: unknown }>;
      // Still gets a breakpoint so the conversation caches, but no tail block.
      expect(content).toHaveLength(1);
      expect(content[0]!.cache_control).toBeDefined();
    });
  });

  describe('warm-cache-miss detector (Agent.isWarmCacheMiss)', () => {
    const BIG = 20_000;
    const WARM = 60_000; // 1 min — well inside the TTL grace window

    it('fires when a warm large prompt reads back almost nothing', () => {
      // prev prompt 20k, this prompt 20k, only 100 cached, 1 min later → broken.
      expect(Agent.isWarmCacheMiss(BIG, BIG, 100, WARM)).toBe(true);
    });

    it('does NOT fire on a healthy warm read (most of the prefix cached)', () => {
      expect(Agent.isWarmCacheMiss(BIG, BIG, 19_000, WARM)).toBe(false);
    });

    it('does NOT fire on a cold start (no prior call)', () => {
      expect(Agent.isWarmCacheMiss(0, BIG, 0, Infinity)).toBe(false);
    });

    it('does NOT fire on a post-TTL resume (gap beyond the grace window)', () => {
      const PAST_TTL = 55 * 60 * 1000;
      expect(Agent.isWarmCacheMiss(BIG, BIG, 0, PAST_TTL)).toBe(false);
    });

    it('does NOT fire on small prompts where caching barely matters', () => {
      expect(Agent.isWarmCacheMiss(500, 800, 0, WARM)).toBe(false);
    });
  });

  /**
   * The detector used to be gated on `!isCustomProxy`, silencing it for every
   * openai-compatible provider on the premise that they "never report
   * cache_read". A real Mistral thread disproved that (117,088 cache-read
   * tokens on one turn, 20,528 on another).
   *
   * But the obvious inverse — "trust the registered cache mechanism" — is wrong
   * in the OTHER direction, and that is the trap these tests exist to hold shut.
   * `custom` is registered `automatic-prefix`, yet the engine strips its
   * `cache_control` (Anthropic-wire) and withholds `prompt_cache_key`
   * (openai-wire only), so it reports zero cache reads BY CONSTRUCTION. A
   * mechanism-gated detector would warn such a user on every tool-loop
   * iteration, seconds apart, forever — precisely the "cry wolf on an entire
   * provider class" the original gate was defending against.
   *
   * So the load-bearing gate is OBSERVATION (`sawCacheRead`), and the mechanism
   * only selects the grace WINDOW, which is a TTL question.
   */
  describe('cache-mechanism grace windows (Agent.cacheGraceMsFor)', () => {
    it('gives explicit-breakpoint providers the 1h-TTL window', () => {
      expect(Agent.cacheGraceMsFor('explicit-breakpoint')).toBe(50 * 60 * 1000);
    });

    it('gives automatic-prefix providers a much SHORTER window', () => {
      const prefix = Agent.cacheGraceMsFor('automatic-prefix');
      expect(prefix).toBe(5 * 60 * 1000);
      expect(prefix).toBeLessThan(Agent.cacheGraceMsFor('explicit-breakpoint'));
    });

    it('gives a `none` mechanism a zero window', () => {
      expect(Agent.cacheGraceMsFor('none')).toBe(0);
    });
  });

  describe('full warn decision (Agent.shouldWarnCacheMiss)', () => {
    const BIG = 20_000;
    /** A blatant miss: big warm prompt, almost nothing read back. */
    const miss = { prevPrompt: BIG, realInput: BIG, cacheRead: 100, gapMs: 60_000 } as const;

    it('WARNS on an automatic-prefix provider — the case the old gate silenced', () => {
      expect(Agent.shouldWarnCacheMiss({
        ...miss, mechanism: 'automatic-prefix', sawCacheRead: true,
      })).toBe(true);
    });

    it('warns on an explicit-breakpoint provider (unchanged behaviour)', () => {
      expect(Agent.shouldWarnCacheMiss({
        ...miss, mechanism: 'explicit-breakpoint', sawCacheRead: true,
      })).toBe(true);
    });

    /**
     * The regression guard for the `custom` provider. It is registered
     * `automatic-prefix`, so mechanism alone would arm the detector — but it
     * can never produce a cache read, so every call looks like a total miss.
     */
    it('stays SILENT on a provider that has never produced a cache read', () => {
      expect(Agent.shouldWarnCacheMiss({
        ...miss, mechanism: 'automatic-prefix', sawCacheRead: false,
      })).toBe(false);
    });

    it('stays silent on a never-caching provider even inside a tool loop '
      + '(seconds apart, zero cache) — the every-iteration false positive', () => {
      expect(Agent.shouldWarnCacheMiss({
        prevPrompt: BIG, realInput: BIG, cacheRead: 0, gapMs: 3_000,
        mechanism: 'automatic-prefix', sawCacheRead: false,
      })).toBe(false);
      // ...and the SAME call on an endpoint that has cached before IS a break.
      expect(Agent.shouldWarnCacheMiss({
        prevPrompt: BIG, realInput: BIG, cacheRead: 0, gapMs: 3_000,
        mechanism: 'automatic-prefix', sawCacheRead: true,
      })).toBe(true);
    });

    it('stays silent for a `none` mechanism even on a blatant miss', () => {
      expect(Agent.shouldWarnCacheMiss({
        ...miss, gapMs: 1_000, mechanism: 'none', sawCacheRead: true,
      })).toBe(false);
    });

    it('stays silent for `none` even when the clock jumped BACKWARDS (negative gap)', () => {
      // The zero grace window alone would not hold here: `gapMs < graceMs`
      // is `-5000 < 0` → true, so the mechanism check has to reject first.
      // An NTP correction mid-run is the realistic way to produce this.
      expect(Agent.shouldWarnCacheMiss({
        ...miss, gapMs: -5_000, mechanism: 'none', sawCacheRead: true,
      })).toBe(false);
    });

    it('does NOT warn on an automatic-prefix gap past its short window, where an '
      + 'explicit-breakpoint provider still would', () => {
      const gapMs = 30 * 60 * 1000; // inside the 1h breakpoint grace, past the 5min prefix one
      expect(Agent.shouldWarnCacheMiss({
        ...miss, gapMs, mechanism: 'automatic-prefix', sawCacheRead: true,
      })).toBe(false);
      expect(Agent.shouldWarnCacheMiss({
        ...miss, gapMs, mechanism: 'explicit-breakpoint', sawCacheRead: true,
      })).toBe(true);
    });

    it('does NOT warn on the very first call of a session (no prior prompt)', () => {
      expect(Agent.shouldWarnCacheMiss({
        ...miss, prevPrompt: 0, gapMs: Infinity,
        mechanism: 'explicit-breakpoint', sawCacheRead: true,
      })).toBe(false);
    });
  });
});
