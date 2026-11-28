import { describe, it, expect } from 'vitest';
import { isAccessEnded, isSessionExpired, markAccessEnded, markSessionExpired } from './session.svelte.js';

// An ended access has its own notice (U-306 B2): signing in again does not bring it back, so the
// expired banner with its sign-in button must not come over it, not even from a later 401.
describe('an ended access holds back the expired session', () => {
	it('takes the place of the expired banner, and a later 401 does not bring it back', () => {
		expect(isAccessEnded()).toBe(false);
		markSessionExpired();
		expect(isSessionExpired()).toBe(true);
		markAccessEnded();
		expect(isAccessEnded()).toBe(true);
		expect(isSessionExpired()).toBe(false);
		markSessionExpired();
		expect(isSessionExpired()).toBe(false);
		expect(isAccessEnded()).toBe(true);
	});
});
