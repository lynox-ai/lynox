import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetTouchPrimaryCache, isTouchPrimary } from './touch-detect.js';

const ORIGINAL_WINDOW = (globalThis as { window?: unknown }).window;

function installWindow(matchMediaImpl: ((q: string) => { matches: boolean }) | undefined): void {
	__resetTouchPrimaryCache();
	(globalThis as { window?: unknown }).window =
		matchMediaImpl === undefined
			? undefined
			: { matchMedia: matchMediaImpl };
}

beforeEach(() => {
	__resetTouchPrimaryCache();
});

afterEach(() => {
	__resetTouchPrimaryCache();
	(globalThis as { window?: unknown }).window = ORIGINAL_WINDOW;
});

describe('isTouchPrimary', () => {
	it('returns false when window is unavailable (SSR)', () => {
		(globalThis as { window?: unknown }).window = undefined;
		expect(isTouchPrimary()).toBe(false);
	});

	it('returns false when matchMedia is missing', () => {
		__resetTouchPrimaryCache();
		(globalThis as { window?: unknown }).window = {};
		expect(isTouchPrimary()).toBe(false);
	});

	it('returns true when the touch-primary media query matches', () => {
		installWindow((q) => ({ matches: q === '(hover: none) and (pointer: coarse)' }));
		expect(isTouchPrimary()).toBe(true);
	});

	it('returns false when the media query does not match (desktop / hybrid with keyboard)', () => {
		installWindow(() => ({ matches: false }));
		expect(isTouchPrimary()).toBe(false);
	});

	it('memoises the result across calls', () => {
		let calls = 0;
		installWindow(() => {
			calls += 1;
			return { matches: true };
		});
		isTouchPrimary();
		isTouchPrimary();
		isTouchPrimary();
		expect(calls).toBe(1);
	});

	it('returns false when matchMedia throws', () => {
		installWindow(() => {
			throw new Error('boom');
		});
		expect(isTouchPrimary()).toBe(false);
	});
});
