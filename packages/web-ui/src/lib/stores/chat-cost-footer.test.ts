import { describe, it, expect } from 'vitest';

import {
	mergeDoneUsage,
	usageFromDoneEvent,
	formatTurnTokens,
	formatUsageMeta,
	type UsageInfo,
} from './chat-usage.js';

/**
 * Regression: the chat cost footer used to ACCUMULATE `turn_end` events. Every
 * agent-loop iteration (api_setup, web_research, plan_task, spawn) fires a
 * `turn_end`, so multi-turn runs added up 3-6× the real cost. The engine's
 * authoritative per-run total is echoed on the `done` SSE event via
 * `session.getLastRunUsage()` — the UI must REPLACE on `done`, not accumulate.
 *
 * This suite locks down the helper that parses the `done` payload AND the
 * contract that `done` always wins, so the cost shown in the footer matches
 * what `/api/history/cost/daily` aggregates from RunHistory.
 */
describe('usageFromDoneEvent', () => {
	it('returns null for missing or malformed payloads', () => {
		expect(usageFromDoneEvent(undefined)).toBeNull();
		expect(usageFromDoneEvent(null)).toBeNull();
		expect(usageFromDoneEvent('not-an-object')).toBeNull();
		expect(usageFromDoneEvent(42)).toBeNull();
	});

	it('extracts the engine `RunUsageSummary` shape', () => {
		const parsed = usageFromDoneEvent({
			tokensIn: 42365,
			tokensOut: 1280,
			cacheRead: 38000,
			cacheWrite: 1500,
			costUsd: 0.0430,
			model: 'mistral-large-2512',
		});
		expect(parsed).toEqual({
			tokensIn: 42365,
			tokensOut: 1280,
			cacheRead: 38000,
			cacheWrite: 1500,
			costUsd: 0.0430,
			model: 'mistral-large-2512',
		});
	});

	it('defaults missing fields to 0 and omits model when absent', () => {
		const parsed = usageFromDoneEvent({});
		expect(parsed).toEqual({
			tokensIn: 0,
			tokensOut: 0,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0,
		});
		expect(parsed?.model).toBeUndefined();
	});

	it('ignores non-string model values', () => {
		const parsed = usageFromDoneEvent({ costUsd: 0.01, model: 123 });
		expect(parsed).toEqual({
			tokensIn: 0,
			tokensOut: 0,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0.01,
		});
	});
});

describe('mergeDoneUsage — REPLACE-on-done contract (multi-turn cost footer)', () => {
	// `mergeDoneUsage` IS the production path used by the `done` SSE handler in
	// chat.svelte.ts. Tested directly so the regression locks down the public
	// contract: done ALWAYS replaces, never accumulates.
	const applyDoneEvent = mergeDoneUsage;

	it('REPLACES a turn_end-accumulated total with the engine authoritative value', () => {
		// 3 turn_end events accumulated (6× real cost — typical api_setup loop)
		const accumulated: UsageInfo = {
			tokensIn: 120_000,
			tokensOut: 4500,
			cacheRead: 100_000,
			cacheWrite: 8000,
			costUsd: 0.27, // bug: would have shown $0.27
			model: 'mistral-large-2512',
		};
		// Engine's authoritative per-run total
		const result = applyDoneEvent(accumulated, {
			tokensIn: 42_365,
			tokensOut: 1280,
			cacheRead: 38_000,
			cacheWrite: 1500,
			costUsd: 0.043, // actual cost matches RunHistory
			model: 'mistral-large-2512',
		});
		expect(result?.costUsd).toBe(0.043);
		expect(result?.tokensIn).toBe(42_365);
		expect(result?.tokensOut).toBe(1280);
		// Critically: NOT 0.27 + 0.043 (the old accumulation bug)
		expect(result?.costUsd).toBeLessThan(0.27);
	});

	it('preserves apiCostUsd (third-party DataForSEO etc.) on done replacement', () => {
		const prior: UsageInfo = {
			tokensIn: 50_000,
			tokensOut: 2000,
			cacheRead: 40_000,
			cacheWrite: 1000,
			costUsd: 0.08, // turn_end-accumulated, stale
			apiCostUsd: 0.0006, // 1 DataForSEO call mid-run
		};
		const result = applyDoneEvent(prior, {
			tokensIn: 20_000,
			tokensOut: 800,
			cacheRead: 17_000,
			cacheWrite: 500,
			costUsd: 0.025,
			model: 'mistral-medium-2508',
		});
		expect(result?.costUsd).toBe(0.025);
		expect(result?.apiCostUsd).toBe(0.0006);
		expect(result?.model).toBe('mistral-medium-2508');
	});

	it('REPLACES even when prior usage exists (no !msg.usage guard)', () => {
		// This is the exact bug guard that used to be there. A subsequent done
		// MUST overwrite a stale turn_end total.
		const prior: UsageInfo = { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, costUsd: 99.99 };
		const result = applyDoneEvent(prior, { tokensIn: 100, tokensOut: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 });
		expect(result?.costUsd).toBe(0.001);
	});

	it('leaves prior usage untouched when done payload is malformed', () => {
		const prior: UsageInfo = { tokensIn: 100, tokensOut: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.05 };
		const result = applyDoneEvent(prior, undefined);
		expect(result).toBe(prior);
	});

	it('seeds usage when no prior exists (lost turn_end fallback path still works)', () => {
		const result = applyDoneEvent(undefined, {
			tokensIn: 500,
			tokensOut: 100,
			cacheRead: 0,
			cacheWrite: 0,
			costUsd: 0.002,
			model: 'mistral-small-2603',
		});
		expect(result?.costUsd).toBe(0.002);
		expect(result?.tokensIn).toBe(500);
		expect(result?.model).toBe('mistral-small-2603');
		expect(result?.apiCostUsd).toBeUndefined();
	});
});

/**
 * Footer CLARITY (2026-07-08): the `N tokens` value is a per-turn SUM across
 * every internal tool-loop iteration of the run, so it can legitimately exceed
 * the model's context window and reads as "broken" without a qualifier. The
 * footer is split into `formatTurnTokens` (the `Σ`-prefixed sum) + a separate
 * co-located occupancy chip (the real window fill), with the $/cache/model tail
 * rendered by `formatUsageMeta`. These lock the split so the token count and the
 * meta stay distinct and the sum-nature is glanceable.
 */
describe('formatTurnTokens — per-turn SUM label', () => {
	it('prefixes Σ and sums tokensIn + tokensOut (may exceed the window)', () => {
		const u: UsageInfo = { tokensIn: 1_500_000, tokensOut: 23_000, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
		const s = formatTurnTokens(u);
		expect(s.startsWith('Σ ')).toBe(true);
		expect(s.endsWith(' tokens')).toBe(true);
		// Sum of in + out, locale-formatted — re-derived to stay locale-agnostic.
		expect(s).toContain((1_523_000).toLocaleString());
	});
});

describe('formatUsageMeta — footer tail (token count excluded)', () => {
	it('omits the token count and joins cost · cache · model', () => {
		const u: UsageInfo = { tokensIn: 1000, tokensOut: 200, cacheRead: 500, cacheWrite: 0, costUsd: 0.04, model: 'mistral-large-2512' };
		const s = formatUsageMeta(u, true);
		expect(s).not.toContain('tokens');
		expect(s).toContain('$0.04');
		expect(s).toContain('50% cache'); // cacheRead / tokensIn = 500 / 1000
		expect(s).toContain('mistral-large-2512');
	});

	it('omits the dollar figures when includeCost=false (demo tenants)', () => {
		const u: UsageInfo = { tokensIn: 1000, tokensOut: 200, cacheRead: 500, cacheWrite: 0, costUsd: 0.04, model: 'demo-model' };
		const s = formatUsageMeta(u, false);
		expect(s).not.toContain('$');
		expect(s).toContain('50% cache');
		expect(s).toContain('demo-model');
	});

	it('surfaces third-party API cost above the $0.001 threshold', () => {
		const u: UsageInfo = { tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.02, apiCostUsd: 0.05 };
		expect(formatUsageMeta(u, true)).toContain('API: $0.05');
	});

	it('drops cache when there were no cache reads', () => {
		const u: UsageInfo = { tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.02 };
		expect(formatUsageMeta(u, true)).not.toContain('cache');
	});
});
