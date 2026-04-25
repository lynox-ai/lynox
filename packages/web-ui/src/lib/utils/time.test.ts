import { describe, expect, it } from 'vitest';
import { formatCountdown } from './time.js';

describe('formatCountdown', () => {
	it('formats sub-minute as M:SS (M is 0)', () => {
		expect(formatCountdown(0)).toBe('0:00');
		expect(formatCountdown(7)).toBe('0:07');
		expect(formatCountdown(59)).toBe('0:59');
	});

	it('formats minutes:seconds when under one hour', () => {
		expect(formatCountdown(60)).toBe('1:00');
		expect(formatCountdown(125)).toBe('2:05');
		expect(formatCountdown(3599)).toBe('59:59');
	});

	it('formats hours:minutes:seconds at and above one hour', () => {
		expect(formatCountdown(3600)).toBe('1:00:00');
		expect(formatCountdown(3661)).toBe('1:01:01');
		expect(formatCountdown(7325)).toBe('2:02:05');
	});

	it('handles the 24h resumable-prompt default without overflow', () => {
		// Regression for v1.3.5: showed `1439:40` instead of `23:59:40`.
		expect(formatCountdown(86340)).toBe('23:59:00');
		expect(formatCountdown(86380)).toBe('23:59:40');
		expect(formatCountdown(86400)).toBe('24:00:00');
	});

	it('clamps negative input to 0:00', () => {
		expect(formatCountdown(-5)).toBe('0:00');
	});

	it('floors non-integer seconds', () => {
		expect(formatCountdown(7.9)).toBe('0:07');
	});
});
