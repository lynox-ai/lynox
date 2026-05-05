import { describe, expect, it, vi } from 'vitest';
import { currentDateContext, withCurrentTimePrefix } from './prompts.js';

describe('currentDateContext', () => {
	it('truncates the current ISO timestamp to the hour', () => {
		// Stub Date so the test is deterministic across all minute boundaries.
		// Hour-truncation is what keeps the Anthropic prompt cache key stable
		// for the full hour — losing that defeats the whole point of the
		// helper, so the contract is worth pinning explicitly.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-05T08:41:23.456Z'));
		const ctx = currentDateContext();
		expect(ctx).toContain('2026-05-05T08:00:00Z');
		expect(ctx).not.toContain('08:41');
		expect(ctx).toContain('Tuesday');
		vi.useRealTimers();
	});

	it('mentions the per-turn fallback so the model knows where to read precise time', () => {
		// The hour-truncated value can lag by up to 59 minutes, which broke
		// "in 5 min" scheduling in the 2026-05-05 incident. The per-turn
		// `[Now: …Z]` marker is the precise source of truth; the docstring
		// has to point at it or the LLM keeps trusting the stale hour.
		const ctx = currentDateContext();
		expect(ctx).toMatch(/per-turn|user message|\[Now/i);
	});
});

describe('withCurrentTimePrefix', () => {
	it('prepends a [Now: <iso>] marker to a string user message', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-05T08:41:23.456Z'));
		const out = withCurrentTimePrefix('hello');
		expect(out).toBe('[Now: 2026-05-05T08:41:23.456Z]\n\nhello');
		vi.useRealTimers();
	});

	it('inserts a leading text block for a multimodal content array', () => {
		// Telegram + image flow lands here: the user message is an array of
		// { type: 'image' | 'text', … } blocks, not a plain string. We can't
		// just string-prepend; we have to splice in a text block.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-05T08:41:23.456Z'));
		const inArr = [
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } },
			{ type: 'text', text: 'what is this?' },
		];
		const out = withCurrentTimePrefix(inArr) as Array<{ type: string; text?: string }>;
		expect(out).toHaveLength(3);
		expect(out[0]).toEqual({ type: 'text', text: '[Now: 2026-05-05T08:41:23.456Z]' });
		expect(out[1]?.type).toBe('image');
		expect(out[2]?.text).toBe('what is this?');
		vi.useRealTimers();
	});

	it('returns unrecognised input shapes unchanged (defensive — should not happen at runtime)', () => {
		// Belt-and-suspenders: agent.send is typed `string | unknown[]`, but
		// if a future caller hands a weird value we don't want the prefix
		// helper to throw. Pass-through preserves the existing failure mode.
		const weird = { foo: 'bar' } as unknown as string;
		expect(withCurrentTimePrefix(weird)).toBe(weird);
	});
});
