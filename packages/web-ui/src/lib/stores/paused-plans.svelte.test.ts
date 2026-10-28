import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPausedPlansNav, getPausedPlansBadge, refreshPausedPlans } from './paused-plans.svelte.js';

// The dot at "Automation" (ux UX-032): the owner's count of paused plans, kept current while the
// tab is visible; a helper's session asks once and stops, so its trail gets one line per load.

let answer: { status: number; body: unknown } = { status: 200, body: {} };
let reads = 0;
let stop: (() => void) | undefined;
let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
	reads = 0;
	visibility = 'visible';
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
	vi.stubGlobal('fetch', vi.fn(async () => {
		reads++;
		return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
	}));
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
	stop?.();
	stop = undefined;
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('the paused-plans dot', () => {
	it('shows the owner\'s count, and follows it on the poll', async () => {
		answer = { status: 200, body: { viewer: 'owner', count: 3 } };
		stop = startPausedPlansNav(1000);
		await settle();
		expect(getPausedPlansBadge()).toBe(3);
		answer = { status: 200, body: { viewer: 'owner', count: 0 } };
		vi.advanceTimersByTime(1000);
		await settle();
		expect([reads, getPausedPlansBadge()]).toEqual([2, null]);
	});

	it('a helper\'s session asks once and shows nothing', async () => {
		answer = { status: 200, body: { viewer: 'mandate', count: null } };
		stop = startPausedPlansNav(1000);
		await settle();
		vi.advanceTimersByTime(5000);
		await settle();
		expect([reads, getPausedPlansBadge()]).toEqual([1, null]);
	});

	it('a hidden tab is not asked on the poll', async () => {
		answer = { status: 200, body: { viewer: 'owner', count: 2 } };
		stop = startPausedPlansNav(1000);
		await settle();
		visibility = 'hidden';
		vi.advanceTimersByTime(3000);
		await settle();
		expect(reads).toBe(1);
	});

	it('a count claimed for another viewer, or a failed read, shows no number', async () => {
		answer = { status: 200, body: { viewer: 'mandate', count: 4 } };
		stop = startPausedPlansNav(1000);
		await settle();
		expect(getPausedPlansBadge()).toBeNull();
		stop();
		answer = { status: 500, body: {} };
		stop = startPausedPlansNav(1000);
		await settle();
		expect(getPausedPlansBadge()).toBeNull();
	});

	it('a takeover asks again at once', async () => {
		answer = { status: 200, body: { viewer: 'owner', count: 1 } };
		stop = startPausedPlansNav(60_000);
		await settle();
		answer = { status: 200, body: { viewer: 'owner', count: 0 } };
		refreshPausedPlans();
		await settle();
		expect([reads, getPausedPlansBadge()]).toEqual([2, null]);
	});
});

