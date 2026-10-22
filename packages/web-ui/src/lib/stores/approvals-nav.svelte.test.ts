import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	APPROVALS_COUNT_POLL_MS, approvalsNavItem, getApprovalsBadge, getApprovalsEnabled, getApprovalsViewer,
	resetApprovalsNavForTest, setApprovalsPending, startApprovalsNav,
} from './approvals.svelte.js';

// The approval queue's nav item: shown only when the count answers ok (the route is 404 while the
// queue is off), with the waiting count as its badge while the latest answer names the owner.
// The count is polled only then: every read a mandate's session makes is written to the owner's
// trail, and whose session it is can change under an open page.

type Answer = { status: number; body?: unknown } | Error | Promise<Response>;
/** Answers for the next count reads, in order; the last one repeats. */
let answers: Answer[];
let countReads = 0;
let renewReads = 0;
let stop: (() => void) | undefined;

const owner = (pending = 3): Answer => ({ status: 200, body: { pending, viewer: 'owner' } });
const mandate = (pending = 2): Answer => ({ status: 200, body: { pending, viewer: 'mandate' } });

beforeEach(() => {
	resetApprovalsNavForTest();
	countReads = 0;
	renewReads = 0;
	answers = [owner()];
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		// A server without a session secret refuses the renewal; the count does not depend on it.
		if (u.endsWith('/auth/renew')) { renewReads++; return new Response('{}', { status: 401 }); }
		if (!u.endsWith('/approvals/count')) return new Response('{}', { status: 404 });
		countReads++;
		const a = answers.length > 1 ? answers.shift()! : answers[0]!;
		if (a instanceof Error) throw a;
		if (a instanceof Promise) return a;
		return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
	}));
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
	stop?.();
	stop = undefined;
	vi.useRealTimers();
	vi.unstubAllGlobals();
	setVisibility('visible');
	resetApprovalsNavForTest();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function ticks(n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		vi.advanceTimersByTime(APPROVALS_COUNT_POLL_MS);
		await settle();
	}
}

function setVisibility(state: 'visible' | 'hidden'): void {
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

async function becomeVisible(): Promise<void> {
	setVisibility('visible');
	document.dispatchEvent(new Event('visibilitychange'));
	await settle();
}

describe('the nav item', () => {
	it('is hidden when the count answers 404 (the queue is off), and nothing is polled', async () => {
		answers = [{ status: 404, body: { error: 'Not found' } }];
		stop = startApprovalsNav();
		await settle();
		expect(getApprovalsEnabled()).toBe(false);
		expect(getApprovalsBadge()).toBeNull();
		expect(approvalsNavItem()).toBeNull();
		await ticks(3);
		expect(countReads).toBe(1);
	});

	it('shows when the count answers ok, with the waiting count as its badge', async () => {
		stop = startApprovalsNav();
		await settle();
		expect(getApprovalsEnabled()).toBe(true);
		expect(getApprovalsBadge()).toBe(3);
		expect(approvalsNavItem()).toEqual({ href: '/app/approvals', labelKey: 'nav.approvals', exact: false, icon: 'send', badge: 3 });
	});

	it('has no badge when nothing waits', async () => {
		answers = [owner(0)];
		stop = startApprovalsNav();
		await settle();
		expect(getApprovalsEnabled()).toBe(true);
		expect(getApprovalsBadge()).toBeNull();
		expect(approvalsNavItem()?.badge).toBeNull();
	});

	it('shows in a mandate\'s session too, without a badge', async () => {
		answers = [mandate(2)];
		stop = startApprovalsNav();
		await settle();
		expect(approvalsNavItem()).toEqual({ href: '/app/approvals', labelKey: 'nav.approvals', exact: false, icon: 'send', badge: null });
		// A list read in that session carries a count too; it still makes no badge.
		setApprovalsPending(5);
		expect(getApprovalsBadge()).toBeNull();
	});
});

describe('the count poll', () => {
	it('runs while the answers name the owner, one read per tick', async () => {
		stop = startApprovalsNav();
		await settle();
		expect(countReads).toBe(1);
		await ticks(3);
		expect(countReads).toBe(4);
		expect(getApprovalsBadge()).toBe(3);
	});

	it('never runs in a mandate\'s session, which also shows no badge', async () => {
		answers = [mandate()];
		stop = startApprovalsNav();
		await settle();
		await ticks(3);
		expect(countReads).toBe(1);
		expect(getApprovalsViewer()).toBe('mandate');
		expect(getApprovalsEnabled()).toBe(true);
		expect(getApprovalsBadge()).toBeNull();
	});

	it('never runs in a session the server cannot name', async () => {
		answers = [{ status: 200, body: { pending: 0, viewer: 'none' } }];
		stop = startApprovalsNav();
		await settle();
		await ticks(3);
		expect(countReads).toBe(1);
		expect(getApprovalsBadge()).toBeNull();
	});

	it('takes an answer without a known viewer (an older engine) as no one it can name', async () => {
		for (const body of [{ pending: 3 }, { pending: 3, viewer: 'OWNER' }, { pending: 3, viewer: 1 }]) {
			resetApprovalsNavForTest();
			countReads = 0;
			answers = [{ status: 200, body }];
			const s = startApprovalsNav();
			await settle();
			await ticks(2);
			s();
			expect(countReads).toBe(1);
			expect(getApprovalsViewer()).toBe('none');
			expect(getApprovalsBadge()).toBeNull();
		}
	});

	it('stops, and drops the badge, when an answer names a mandate instead of the owner', async () => {
		answers = [owner(3), owner(3), mandate(2)];
		stop = startApprovalsNav();
		await settle();
		await ticks(1);
		expect(countReads).toBe(2);
		expect(getApprovalsBadge()).toBe(3);
		await ticks(1);
		expect(countReads).toBe(3);
		expect(getApprovalsViewer()).toBe('mandate');
		expect(getApprovalsBadge()).toBeNull();
		await ticks(3);
		expect(countReads).toBe(3);
		// Nor does the tab coming back read again.
		await becomeVisible();
		expect(countReads).toBe(3);
	});

	it('does not depend on the session renewal: an owner it refuses (no session secret) still gets badge and poll', async () => {
		stop = startApprovalsNav();
		await settle();
		await ticks(2);
		expect(countReads).toBe(3);
		expect(getApprovalsBadge()).toBe(3);
		expect(renewReads).toBe(0);
	});

	it('stops when the shell goes', async () => {
		stop = startApprovalsNav();
		await settle();
		stop();
		await ticks(3);
		await becomeVisible();
		expect(countReads).toBe(1);
	});

	it('does not start when the shell went before the first answer came', async () => {
		let release!: (r: Response) => void;
		answers = [new Promise<Response>((r) => { release = r; }), owner()];
		stop = startApprovalsNav();
		await settle();
		stop();
		release(new Response(JSON.stringify({ pending: 3, viewer: 'owner' }), { status: 200 }));
		await settle();
		await ticks(3);
		await becomeVisible();
		expect(countReads).toBe(1);
	});
});

describe('the tab coming back to the foreground', () => {
	it('reads the count in the owner\'s session, and not while it is hidden', async () => {
		stop = startApprovalsNav(3_600_000);
		await settle();
		expect(countReads).toBe(1);
		setVisibility('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(countReads).toBe(1);
		await becomeVisible();
		expect(countReads).toBe(2);
	});

	it('reads nothing in a mandate\'s session', async () => {
		answers = [mandate()];
		stop = startApprovalsNav(3_600_000);
		await settle();
		await becomeVisible();
		expect(countReads).toBe(1);
	});
});

describe('an answer that is not one', () => {
	it('a 5xx keeps the item and the poll, hides the badge until the next answer', async () => {
		answers = [owner(3), { status: 503, body: { error: 'Service unavailable' } }, owner(4)];
		stop = startApprovalsNav();
		await settle();
		await ticks(1);
		expect(countReads).toBe(2);
		expect(getApprovalsEnabled()).toBe(true);
		expect(approvalsNavItem()).not.toBeNull();
		expect(getApprovalsBadge()).toBeNull();
		await ticks(1);
		expect(countReads).toBe(3);
		expect(getApprovalsBadge()).toBe(4);
	});

	it('a 401 or 403 does the same: it says nothing about the queue', async () => {
		for (const status of [401, 403, 500, 502]) {
			resetApprovalsNavForTest();
			countReads = 0;
			answers = [owner(3), { status, body: {} }, owner(4)];
			const s = startApprovalsNav();
			await settle();
			await ticks(1);
			expect(getApprovalsEnabled(), String(status)).toBe(true);
			expect(getApprovalsBadge(), String(status)).toBeNull();
			await ticks(1);
			s();
			expect(countReads, String(status)).toBe(3);
			expect(getApprovalsBadge(), String(status)).toBe(4);
		}
	});

	it('a network error keeps the item and the poll, hides the badge until the next answer', async () => {
		answers = [owner(3), new Error('offline'), owner(4)];
		stop = startApprovalsNav();
		await settle();
		await ticks(1);
		expect(approvalsNavItem()).not.toBeNull();
		expect(getApprovalsBadge()).toBeNull();
		await ticks(1);
		expect(countReads).toBe(3);
		expect(getApprovalsBadge()).toBe(4);
	});

	it('a 404 mid-session hides the item and stops the poll (the queue was turned off)', async () => {
		answers = [owner(3), { status: 404, body: {} }];
		stop = startApprovalsNav();
		await settle();
		await ticks(1);
		expect(approvalsNavItem()).toBeNull();
		expect(getApprovalsBadge()).toBeNull();
		await ticks(3);
		expect(countReads).toBe(2);
	});
});
