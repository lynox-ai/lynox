import { describe, it, expect } from 'vitest';
import { buildContextOptions, formatContextWindow, type ContextMilestone } from './context-window.js';

const MILESTONES: ReadonlyArray<ContextMilestone> = [
	{ value: 32_000,  labelKey: '32k',  hintKey: '32k_hint' },
	{ value: 100_000, labelKey: '100k', hintKey: '100k_hint' },
	{ value: 200_000, labelKey: '200k', hintKey: '200k_hint' },
	{ value: 500_000, labelKey: '500k', hintKey: '500k_hint' },
];

describe('buildContextOptions (Item 8 show-all-grayed)', () => {
	it('returns all milestones enabled when native is undefined (legacy fallback)', () => {
		const out = buildContextOptions(undefined, MILESTONES);
		expect(out).toHaveLength(4);
		for (const o of out) {
			expect(o.disabled).toBe(false);
			expect(o.hidden).toBe(false);
		}
	});

	it('Sonnet base (200K) — 32K + 100K enabled, 200K hidden (redundant), 500K disabled', () => {
		const out = buildContextOptions(200_000, MILESTONES);
		expect(out.map((o) => [o.value, o.disabled, o.hidden])).toEqual([
			[32_000,  false, false],
			[100_000, false, false],
			[200_000, false, true],   // == native → hidden
			[500_000, true,  false],  // > native → disabled (was: silently clamped to 200K)
		]);
	});

	it('Opus 1M native — all four enabled (none exceeds 1M, none equals)', () => {
		const out = buildContextOptions(1_000_000, MILESTONES);
		for (const o of out) {
			expect(o.disabled).toBe(false);
			expect(o.hidden).toBe(false);
		}
	});

	it('Mistral Large (131_072) — 32K + 100K enabled, 200K + 500K disabled', () => {
		const out = buildContextOptions(131_072, MILESTONES);
		expect(out.map((o) => [o.value, o.disabled, o.hidden])).toEqual([
			[32_000,  false, false],
			[100_000, false, false],
			[200_000, true,  false],
			[500_000, true,  false],
		]);
	});

	it('Mistral Small (32_000) — 32K hidden (redundant), rest disabled', () => {
		const out = buildContextOptions(32_000, MILESTONES);
		expect(out.map((o) => [o.value, o.disabled, o.hidden])).toEqual([
			[32_000,  false, true],   // == native → hidden
			[100_000, true,  false],
			[200_000, true,  false],
			[500_000, true,  false],
		]);
	});
});

describe('formatContextWindow', () => {
	it('renders Sonnet base as 200K', () => {
		expect(formatContextWindow(200_000)).toBe('200K');
	});

	it('renders Opus 1M native as "1M" (regression: pre-fix rendered "1000K")', () => {
		expect(formatContextWindow(1_000_000)).toBe('1M');
	});

	it('renders Mistral Large 131_072 as 131K', () => {
		// Math.round(131_072 / 1000) = 131
		expect(formatContextWindow(131_072)).toBe('131K');
	});

	it('renders Mistral Small 32K', () => {
		expect(formatContextWindow(32_000)).toBe('32K');
	});

	it('renders fractional millions with one decimal (forward-compat)', () => {
		// Anthropic / Mistral haven't shipped a 2.5M tier, but the formatter
		// shouldn't render "2500K" if they do.
		expect(formatContextWindow(2_500_000)).toBe('2.5M');
	});

	it('strips trailing .0 on whole-million values', () => {
		expect(formatContextWindow(2_000_000)).toBe('2M');
	});

	it('rounds near-1M values to "1M" rather than "1000K"', () => {
		// Math.round(999_999 / 1000) = 1000 → would render "1000K" if the
		// boundary check were `>= 1_000_000`; the rounded-K threshold catches it.
		expect(formatContextWindow(999_999)).toBe('1M');
		expect(formatContextWindow(999_500)).toBe('1M');
	});

	it('renders below-rounding-boundary values as "K"', () => {
		expect(formatContextWindow(999_499)).toBe('999K');
	});
});
