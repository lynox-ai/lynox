import { describe, it, expect } from 'vitest';
import { filterContextMilestones, formatContextWindow, type ContextMilestone } from './context-window.js';

const MILESTONES: ReadonlyArray<ContextMilestone> = [
	{ value: 32_000,  labelKey: '32k',  hintKey: '32k_hint' },
	{ value: 100_000, labelKey: '100k', hintKey: '100k_hint' },
	{ value: 200_000, labelKey: '200k', hintKey: '200k_hint' },
	{ value: 500_000, labelKey: '500k', hintKey: '500k_hint' },
];

describe('filterContextMilestones', () => {
	it('returns all milestones when native is undefined (legacy fallback)', () => {
		expect(filterContextMilestones(undefined, MILESTONES)).toEqual(MILESTONES);
	});

	it('keeps only milestones strictly below Sonnet base native (200K)', () => {
		// Pre-fix this offered "500k" and "1M" caps that silently clamped to 200k.
		const out = filterContextMilestones(200_000, MILESTONES);
		expect(out.map((m) => m.value)).toEqual([32_000, 100_000]);
	});

	it('keeps all milestones below Opus 1M native', () => {
		// Opus has the full ladder available; "default" still represents 1M.
		const out = filterContextMilestones(1_000_000, MILESTONES);
		expect(out.map((m) => m.value)).toEqual([32_000, 100_000, 200_000, 500_000]);
	});

	it('keeps only 32K + 100K below Mistral Large native (131_072)', () => {
		// Mistral Large is 128K-ish — the 200K and 500K milestones would
		// over-promise the native cap.
		const out = filterContextMilestones(131_072, MILESTONES);
		expect(out.map((m) => m.value)).toEqual([32_000, 100_000]);
	});

	it('returns empty cap list for Mistral Small native (32_000)', () => {
		// 32K is the smallest cap milestone — strictly-less-than rule means
		// nothing remains; UI shows only the "default" option.
		const out = filterContextMilestones(32_000, MILESTONES);
		expect(out).toEqual([]);
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
});
