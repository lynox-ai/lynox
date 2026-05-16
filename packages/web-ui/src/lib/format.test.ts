import { describe, expect, it } from 'vitest';
import {
	estimateCost,
	formatCost,
	formatCostCents,
	formatDuration,
	getModelPricing,
	shortModel,
} from './format.js';

describe('formatCost (USD float — canonical)', () => {
	it('returns "-" for null/undefined/zero (no-data sentinel)', () => {
		expect(formatCost(null)).toBe('-');
		expect(formatCost(undefined)).toBe('-');
		expect(formatCost(0)).toBe('-');
	});

	it('renders sub-cent precision with 4 decimals (migration estimates)', () => {
		// Pattern preserved from ColdStartBanner — see PRD-IA-V2 P1-PR-B.
		expect(formatCost(0.001)).toBe('$0.0010');
		expect(formatCost(0.0042)).toBe('$0.0042');
		expect(formatCost(0.009)).toBe('$0.0090');
	});

	it('renders ≥ $0.01 with 2 decimals', () => {
		expect(formatCost(0.01)).toBe('$0.01');
		expect(formatCost(0.12)).toBe('$0.12');
		expect(formatCost(0.43)).toBe('$0.43');
		expect(formatCost(1.23)).toBe('$1.23');
		expect(formatCost(42.5)).toBe('$42.50');
	});

	it('handles boundary between sub-cent and cent rendering', () => {
		expect(formatCost(0.0099)).toBe('$0.0099');
		expect(formatCost(0.01)).toBe('$0.01');
	});
});

describe('formatCostCents (integer-cents — budget contexts)', () => {
	it('returns "-" for null/undefined', () => {
		expect(formatCostCents(null)).toBe('-');
		expect(formatCostCents(undefined)).toBe('-');
	});

	it('returns "$0.00" for zero (real zero, not a sentinel)', () => {
		expect(formatCostCents(0)).toBe('$0.00');
	});

	it('shows "< $0.01" for sub-integer-cent values (rounded down on wire)', () => {
		// Sub-cent precision is lost when serialized as integer cents over the
		// wire; "< $0.01" signals "non-zero but rounded".
		expect(formatCostCents(0.5)).toBe('< $0.01');
	});

	it('renders ≥ 1 cent in dollar-cent format', () => {
		expect(formatCostCents(1)).toBe('$0.01');
		expect(formatCostCents(12)).toBe('$0.12');
		expect(formatCostCents(100)).toBe('$1.00');
		expect(formatCostCents(1234)).toBe('$12.34');
		expect(formatCostCents(99999)).toBe('$999.99');
	});

	it('pads single-digit cents with leading zero', () => {
		expect(formatCostCents(101)).toBe('$1.01');
		expect(formatCostCents(105)).toBe('$1.05');
	});
});

describe('formatDuration', () => {
	it('returns "-" for null/undefined/zero', () => {
		expect(formatDuration(null)).toBe('-');
		expect(formatDuration(undefined)).toBe('-');
		expect(formatDuration(0)).toBe('-');
	});

	it('renders ms / s / m at appropriate scale', () => {
		expect(formatDuration(500)).toBe('500ms');
		expect(formatDuration(1500)).toBe('1.5s');
		expect(formatDuration(90_000)).toBe('1.5m');
	});
});

describe('shortModel', () => {
	it('strips provider prefix', () => {
		expect(shortModel('anthropic/claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
		expect(shortModel('openai/gpt-5')).toBe('gpt-5');
	});

	it('strips trailing date suffix', () => {
		expect(shortModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
	});
});

describe('getModelPricing + estimateCost', () => {
	it('returns fallback (sonnet) for unknown model', () => {
		const p = getModelPricing('totally-made-up-model');
		expect(p.input).toBe(3);
		expect(p.output).toBe(15);
	});

	it('estimates cost from usage tokens', () => {
		const cost = estimateCost('claude-haiku-4-5-20251001', {
			input_tokens: 1_000_000,
			output_tokens: 0,
		});
		expect(cost).toBeCloseTo(0.80, 4);
	});

	it('includes cache token cost', () => {
		const cost = estimateCost('claude-sonnet-4-6', {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 1_000_000,
			cache_read_input_tokens: 1_000_000,
		});
		// 3.75 + 0.3 = 4.05
		expect(cost).toBeCloseTo(4.05, 4);
	});
});
