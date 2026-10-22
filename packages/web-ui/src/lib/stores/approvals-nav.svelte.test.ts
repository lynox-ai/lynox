import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	APPROVALS_COUNT_POLL_MS, getApprovalsBadge, getApprovalsEnabled, resetApprovalsNavForTest, startApprovalsNav,
} from './approvals.svelte.js';

// The approval queue's nav item: shown only when the count answers ok (the route is 404 while the
// queue is off), with the waiting count as its badge in the owner's session. The count is polled
// only there: every read a mandate's session makes is written to the owner's trail.

let countAnswer: { status: number; body: unknown };
let countReads = 0;
let stop: (() => void) | undefined;

beforeEach(() => {
	resetApprovalsNavForTest();
	countReads = 0;
	countAnswer = { status: 200, body: { pending: 3 } };
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		if (String(url).endsWith('/approvals/count')) countReads++;
		return new Response(JSON.stringify(countAnswer.body), { status: countAnswer.status });
	}));
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
	stop?.();
	stop = undefined;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	resetApprovalsNavForTest();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('the nav item', () => {
	it('is hidden when the count answers 404 (the queue is off)', async () => {
		countAnswer = { status: 404, body: { error: 'Not found' } };
		stop = startApprovalsNav(Promise.resolve('owner'));
		await settle();
		expect(getApprovalsEnabled()).toBe(false);
		expect(getApprovalsBadge()).toBeNull();
	});

	it('shows when the count answers ok, with the waiting count as its badge', async () => {
		stop = startApprovalsNav(Promise.resolve('owner'));
		await settle();
		expect(getApprovalsEnabled()).toBe(true);
		expect(getApprovalsBadge()).toBe(3);
	});

	it('has no badge when nothing waits', async () => {
		countAnswer = { status: 200, body: { pending: 0 } };
		stop = startApprovalsNav(Promise.resolve('owner'));
		await settle();
		expect(getApprovalsEnabled()).toBe(true);
		expect(getApprovalsBadge()).toBeNull();
	});

});

describe('the count poll', () => {
	it('runs in the owner\'s session', async () => {
		stop = startApprovalsNav(Promise.resolve('owner'));
		await settle();
		expect(countReads).toBe(1);
		vi.advanceTimersByTime(APPROVALS_COUNT_POLL_MS * 3);
		await settle();
		expect(countReads).toBe(4);
	});

	it('never runs in a mandate\'s session, which also shows no badge', async () => {
		stop = startApprovalsNav(Promise.resolve('mandate'));
		await settle();
		vi.advanceTimersByTime(APPROVALS_COUNT_POLL_MS * 3);
		await settle();
		expect(countReads).toBe(1);
		expect(getApprovalsEnabled()).toBe(true);
		expect(getApprovalsBadge()).toBeNull();
	});

	it('never runs in a session the server did not name', async () => {
		stop = startApprovalsNav(Promise.resolve(null));
		await settle();
		vi.advanceTimersByTime(APPROVALS_COUNT_POLL_MS * 3);
		await settle();
		expect(countReads).toBe(1);
		expect(getApprovalsBadge()).toBeNull();
	});

	it('stops when the shell goes', async () => {
		stop = startApprovalsNav(Promise.resolve('owner'));
		await settle();
		stop();
		vi.advanceTimersByTime(APPROVALS_COUNT_POLL_MS * 3);
		await settle();
		expect(countReads).toBe(1);
	});
});
