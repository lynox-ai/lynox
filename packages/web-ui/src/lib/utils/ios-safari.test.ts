import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isIosSafari, __resetIosSafariCache } from './ios-safari.js';

const ORIGINAL_NAVIGATOR = globalThis.navigator;

function setUserAgent(ua: string | undefined): void {
	__resetIosSafariCache();
	if (ua === undefined) {
		// @ts-expect-error — deliberate erasure for the SSR / non-browser path.
		delete globalThis.navigator;
		return;
	}
	Object.defineProperty(globalThis, 'navigator', {
		value: { userAgent: ua },
		configurable: true,
	});
}

describe('isIosSafari', () => {
	beforeEach(() => {
		__resetIosSafariCache();
	});

	afterEach(() => {
		Object.defineProperty(globalThis, 'navigator', {
			value: ORIGINAL_NAVIGATOR,
			configurable: true,
		});
		__resetIosSafariCache();
	});

	it('returns true for iPhone Safari', () => {
		setUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1',
		);
		expect(isIosSafari()).toBe(true);
	});

	it('returns true for iPad Safari', () => {
		setUserAgent(
			'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
		);
		expect(isIosSafari()).toBe(true);
	});

	it('returns false for Chrome iOS (CriOS)', () => {
		setUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
		);
		expect(isIosSafari()).toBe(false);
	});

	it('returns false for Firefox iOS (FxiOS)', () => {
		setUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15',
		);
		expect(isIosSafari()).toBe(false);
	});

	it('returns false for Edge iOS (EdgiOS)', () => {
		setUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.2849.68 Mobile/15E148 Safari/604.1',
		);
		expect(isIosSafari()).toBe(false);
	});

	it('returns false for Google Search App (GSA)', () => {
		setUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/372.0.0.0.0 Mobile/15E148 Safari/604.1',
		);
		expect(isIosSafari()).toBe(false);
	});

	it('returns false for desktop Safari on macOS', () => {
		setUserAgent(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
		);
		expect(isIosSafari()).toBe(false);
	});

	it('returns false for Android Chrome', () => {
		setUserAgent(
			'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
		);
		expect(isIosSafari()).toBe(false);
	});

	it('returns false when navigator is undefined (SSR)', () => {
		setUserAgent(undefined);
		expect(isIosSafari()).toBe(false);
	});

	it('caches the result across calls within a session', () => {
		setUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1',
		);
		expect(isIosSafari()).toBe(true);
		// Mutate UA without resetting the cache — should still return cached result.
		Object.defineProperty(globalThis, 'navigator', {
			value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' },
			configurable: true,
		});
		expect(isIosSafari()).toBe(true);
	});
});
