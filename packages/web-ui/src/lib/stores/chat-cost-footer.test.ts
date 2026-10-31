import { describe, it, expect } from 'vitest';

import {
	mergeDoneUsage,
	usageFromDoneEvent,
	formatTurnTokens,
	formatUsageMeta,
	formatUsageMetaParts,
	formatApiCalls,
	shortModelLabel,
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

	it('takes the API calls from the done payload, not from what was streamed before it', () => {
		// The engine counts them from the run's stored calls; a figure streamed earlier (a profile
		// rate, measured 90 times too low once) must not survive the replacement.
		const prior: UsageInfo = {
			tokensIn: 50_000,
			tokensOut: 2000,
			cacheRead: 40_000,
			cacheWrite: 1000,
			costUsd: 0.08, // turn_end-accumulated, stale
			apiCalls: 4,
			apiCostUsd: 0.004, // stale
			apiCostEstimated: true,
		};
		const result = applyDoneEvent(prior, {
			tokensIn: 20_000,
			tokensOut: 800,
			cacheRead: 17_000,
			cacheWrite: 500,
			costUsd: 0.025,
			model: 'mistral-medium-2508',
			apiCalls: 4,
			apiCostUsd: 0.36,
			apiCostEstimated: false,
			apiCallsUnpriced: 0,
		});
		expect(result?.costUsd).toBe(0.025);
		expect(result).toMatchObject({ apiCalls: 4, apiCostUsd: 0.36, apiCostEstimated: false, apiCallsUnpriced: 0 });
		expect(result?.model).toBe('mistral-medium-2508');
	});

	it('never takes more unpriced calls than calls from the done payload', () => {
		const result = applyDoneEvent(undefined, { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0, apiCalls: 2, apiCostUsd: 0, apiCallsUnpriced: 9 });
		expect(result?.apiCallsUnpriced).toBe(2);
	});

	it('drops a streamed API cost when the done payload names no API calls', () => {
		const prior: UsageInfo = { tokensIn: 1, tokensOut: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01, apiCostUsd: 0.004 };
		const result = applyDoneEvent(prior, { tokensIn: 100, tokensOut: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 });
		expect(result).not.toHaveProperty('apiCostUsd');
		expect(result).not.toHaveProperty('apiCalls');
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

	it('shows the run\'s API calls next to the LLM cost (ux U-096)', () => {
		const u: UsageInfo = { tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.02, apiCalls: 4, apiCostUsd: 0.36, apiCostEstimated: false, apiCallsUnpriced: 0 };
		expect(formatUsageMeta(u, true)).toContain('4 API calls · $0.36');
		expect(formatUsageMeta(u, true)).not.toContain('API: ');
		// Demo tenants see no dollar figure, the count included with it.
		expect(formatUsageMeta(u, false)).not.toContain('API call');
	});

	it('drops cache when there were no cache reads', () => {
		const u: UsageInfo = { tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.02 };
		expect(formatUsageMeta(u, true)).not.toContain('cache');
	});
});

/**
 * Hosted-inference providers namespace their ids as a path
 * (`accounts/fireworks/models/glm-5p2`), which crowded the footer line without
 * adding information (2026-07-30). The footer shows the last segment and
 * keeps the full id in the part's `title`, so nothing is lost — the id is the
 * provider/tier verification BYOK users rely on.
 */
describe('shortModelLabel — path-shaped model ids in the footer', () => {
	it('shows only the model segment of a path-shaped id', () => {
		expect(shortModelLabel('accounts/fireworks/models/glm-5p2')).toBe('glm-5p2');
	});

	it('leaves a plain id untouched (every Anthropic / Mistral id)', () => {
		expect(shortModelLabel('mistral-medium-2604')).toBe('mistral-medium-2604');
		expect(shortModelLabel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
	});

	it('falls back to the input when the path has no usable last segment', () => {
		expect(shortModelLabel('weird/')).toBe('weird');
		expect(shortModelLabel('/')).toBe('/');
	});

	it('carries the FULL id in the part title so the verification value survives', () => {
		const u: UsageInfo = { tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.02, model: 'accounts/fireworks/models/glm-5p2' };
		const modelPart = formatUsageMetaParts(u, true).at(-1);
		expect(modelPart).toEqual({ text: 'glm-5p2', title: 'accounts/fireworks/models/glm-5p2' });
	});

	it('adds no title when nothing was shortened (no spurious tooltip)', () => {
		const u: UsageInfo = { tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.02, model: 'mistral-medium-2604' };
		const modelPart = formatUsageMetaParts(u, true).at(-1);
		expect(modelPart).toEqual({ text: 'mistral-medium-2604' });
	});
});

/**
 * A delegated turn is billed across MORE than one run: the main run plus one
 * row per spawned sub-agent. The footer used to show only the main run, so a
 * real deep-review turn read "$0.38" against $0.45 actually billed — an 18%
 * understatement, and the thread total (which sums all rows) did not match the
 * sum of the per-message lines. `spawnCostUsd` carries the children's spend
 * alongside — never folded into `costUsd`, because that value is also the
 * parent's own run row and folding would double-count the thread.
 */
describe('sub-agent cost rollup in the footer', () => {
	const withSpawn: UsageInfo = {
		tokensIn: 258200, tokensOut: 3177, cacheRead: 20528, cacheWrite: 0,
		costUsd: 0.3834, spawnCostUsd: 0.0698, model: 'mistral-medium-2604',
	};

	it('shows the SUM of the main run and its sub-agents', () => {
		const costPart = formatUsageMetaParts(withSpawn, true)[0];
		expect(costPart?.text).toBe('$0.45');
	});

	it('names the parts in the tooltip so the main-run figure stays recoverable', () => {
		const costPart = formatUsageMetaParts(withSpawn, true)[0];
		expect(costPart?.title).toBe('main $0.38 · sub-agents $0.07');
	});

	/**
	 * `formatCost` switches from 2 to 4 decimals below $0.01, so phrasing the
	 * tooltip as "a + b" produced arithmetic that visibly does not check out
	 * whenever the sub-agent spend is sub-cent — the common case for `fast`-tier
	 * children. Labelled parts state the same two numbers without claiming they
	 * add up to the headline at the displayed precision.
	 */
	it('does not render a sum that fails to add up when sub-agent spend is sub-cent', () => {
		const subCent: UsageInfo = {
			tokensIn: 1000, tokensOut: 10, cacheRead: 0, cacheWrite: 0,
			costUsd: 0.375, spawnCostUsd: 0.005,
		};
		const costPart = formatUsageMetaParts(subCent, true)[0];
		// Headline rounds to the same $0.38 as the main run alone...
		expect(costPart?.text).toBe('$0.38');
		// ...so the tooltip must not read as "$0.38 + $0.0050", which invites a
		// subtraction that yields the wrong main-run figure.
		expect(costPart?.title).toBe('main $0.38 · sub-agents $0.0050');
		expect(costPart?.title).not.toContain('+');
	});

	it('leaves a non-delegating turn exactly as before — no sum, no tooltip', () => {
		const plain: UsageInfo = { tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.02 };
		expect(formatUsageMetaParts(plain, true)[0]).toEqual({ text: '$0.02' });
	});

	it('still hides the figures on a demo tenant (includeCost=false)', () => {
		const parts = formatUsageMetaParts(withSpawn, false);
		expect(parts.every((p) => !p.text.startsWith('$'))).toBe(true);
	});

	it('parses spawnCostUsd off the done event', () => {
		const parsed = usageFromDoneEvent({
			tokensIn: 1000, tokensOut: 10, cacheRead: 0, cacheWrite: 0,
			costUsd: 0.3834, spawnCostUsd: 0.0698,
		});
		expect(parsed?.spawnCostUsd).toBe(0.0698);
	});

	it('omits spawnCostUsd when the turn delegated nothing', () => {
		const parsed = usageFromDoneEvent({
			tokensIn: 1000, tokensOut: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.05,
		});
		expect(parsed).not.toHaveProperty('spawnCostUsd');
	});

	it('survives the done-merge that replaces a turn_end-accumulated total', () => {
		const prior: UsageInfo = { tokensIn: 5, tokensOut: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 };
		const merged = mergeDoneUsage(prior, {
			tokensIn: 1000, tokensOut: 10, cacheRead: 0, cacheWrite: 0,
			costUsd: 0.3834, spawnCostUsd: 0.0698,
		});
		expect(merged?.spawnCostUsd).toBe(0.0698);
	});
});

/**
 * The run's third-party API calls (ux U-096). The line has to stand without its tooltip, which a
 * phone does not show, and say whether its amount is the provider's or an estimate: a profile
 * rate once read $0.0040 where the provider billed $0.36.
 */
describe('formatApiCalls — the run\'s API calls in the footer', () => {
	const base: UsageInfo = { tokensIn: 100, tokensOut: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.02 };
	const line = (u: Partial<UsageInfo>) => formatApiCalls({ ...base, ...u })?.text;

	it('every amount from the responses', () => {
		expect(line({ apiCalls: 4, apiCostUsd: 0.36, apiCostEstimated: false, apiCallsUnpriced: 0 })).toBe('4 API calls · $0.36');
		expect(formatApiCalls({ ...base, apiCalls: 4, apiCostUsd: 0.36 })?.title).toBe('From the responses');
	});

	it('any amount from a profile rate makes the whole sum an estimate', () => {
		expect(line({ apiCalls: 4, apiCostUsd: 0.004, apiCostEstimated: true, apiCallsUnpriced: 0 })).toBe('4 API calls · $0.0040 estimated');
	});

	it('no amount known', () => {
		expect(line({ apiCalls: 4, apiCostUsd: 0, apiCostEstimated: false, apiCallsUnpriced: 4 })).toBe('4 API calls · cost unknown');
	});

	it('a sum that leaves calls without an amount out is an estimate too', () => {
		const part = formatApiCalls({ ...base, apiCalls: 4, apiCostUsd: 0.27, apiCostEstimated: false, apiCallsUnpriced: 1 });
		expect(part?.text).toBe('4 API calls · $0.27 estimated');
		expect(part?.title).toContain('1 of 4 without an amount');
	});

	it('one call, a tiny amount and a zero', () => {
		expect(line({ apiCalls: 1, apiCostUsd: 0.09 })).toBe('1 API call · $0.09');
		expect(line({ apiCalls: 2, apiCostUsd: 0.0004 })).toBe('2 API calls · < $0.001');
		expect(line({ apiCalls: 2, apiCostUsd: 0.0004, apiCostEstimated: true })).toBe('2 API calls · < $0.001 estimated');
		expect(line({ apiCalls: 1, apiCostUsd: 0 })).toBe('1 API call · $0');
	});

	it('nothing for a run that sent none', () => {
		expect(formatApiCalls(base)).toBeNull();
		expect(formatApiCalls({ ...base, apiCalls: 0 })).toBeNull();
	});
});

