import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addToast, dismissToast, getToasts } from './toast.svelte.js';

// A message the person has to act on stays until they close it. `setTimeout` takes `Infinity` as
// 1 ms, so "no timeout" has to be said as null, not as a very long duration.
describe('how long a toast stays', () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => {
		for (const t of getToasts()) dismissToast(t.id);
		vi.useRealTimers();
	});

	it('a toast without a duration stays until it is closed', () => {
		addToast('act on this', 'error', null);
		vi.advanceTimersByTime(24 * 60 * 60 * 1000);
		const [toast] = getToasts();
		expect(toast?.message).toBe('act on this');
		dismissToast(toast!.id);
		expect(getToasts()).toEqual([]);
	});

	it('a toast with a duration goes when it ends (control)', () => {
		addToast('passing', 'info', 3000);
		vi.advanceTimersByTime(2999);
		expect(getToasts()).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(getToasts()).toEqual([]);
	});
});
