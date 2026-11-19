import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	APPROVALS_COUNT_POLL_MS, APPROVALS_COUNT_RETRIES, approvalsNavItem, getApprovalsBadge, getApprovalsEnabled, getApprovalsViewer,
	resetApprovalsNavForTest, setApprovalsPending, startApprovalsNav,
} from './approvals.svelte.js';

// The approval queue's nav item: shown only when the count answers with a count (it says
// `enabled: false` while the queue is off; an older engine answered 404), with the waiting count as its badge while the latest answer names the owner.
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
	it.each([
		['says the queue is off', { status: 200, body: { enabled: false } }],
		['answers 404, as an engine before that answer did', { status: 404, body: { error: 'Not found' } }],
	])('is hidden when the count %s, and nothing is polled', async (_label, off) => {
		answers = [off];
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

	it.each([
		['says the queue is off', { status: 200, body: { enabled: false } }],
		['answers 404', { status: 404, body: {} }],
	])('a count that %s mid-session hides the item and stops the poll', async (_label, off) => {
		answers = [owner(3), off];
		stop = startApprovalsNav();
		await settle();
		await ticks(1);
		expect(approvalsNavItem()).toBeNull();
		expect(getApprovalsBadge()).toBeNull();
		await ticks(3);
		expect(countReads).toBe(2);
	});
});

describe('one mount, one session', () => {
	it('shows nothing an earlier mount learned before this one has an answer', async () => {
		answers = [owner(5)];
		stop = startApprovalsNav();
		await settle();
		expect(getApprovalsBadge()).toBe(5);
		stop();
		// The next session's first read does not come back.
		answers = [new Promise<Response>(() => {})];
		stop = startApprovalsNav();
		await settle();
		expect(getApprovalsViewer()).toBeNull();
		expect(getApprovalsBadge()).toBeNull();
		// A list answer in that session does not bring the badge back either.
		setApprovalsPending(4);
		expect(getApprovalsBadge()).toBeNull();
	});

	it('a failed first read in a new mount does not keep the earlier session\'s owner', async () => {
		answers = [owner(5)];
		stop = startApprovalsNav();
		await settle();
		stop();
		answers = [{ status: 502 }];
		stop = startApprovalsNav();
		await settle();
		setApprovalsPending(4);
		expect(getApprovalsViewer()).toBeNull();
		expect(getApprovalsBadge()).toBeNull();
	});

	it('never records an answer to a mount that has stopped', async () => {
		let release!: (r: Response) => void;
		answers = [new Promise<Response>((r) => { release = r; })];
		const first = startApprovalsNav();
		await settle();
		first();
		answers = [mandate(2)];
		stop = startApprovalsNav();
		await settle();
		expect(getApprovalsViewer()).toBe('mandate');
		// The old mount's owner answer arrives late.
		release(new Response(JSON.stringify({ pending: 9, viewer: 'owner' }), { status: 200 }));
		await settle();
		expect(getApprovalsViewer()).toBe('mandate');
		expect(getApprovalsBadge()).toBeNull();
		await ticks(3);
		expect(countReads).toBe(2);
	});

	it('has one read out at a time: a tick or a return to the tab while one runs asks nothing', async () => {
		let release!: (r: Response) => void;
		answers = [owner(3)];
		stop = startApprovalsNav();
		await settle();
		answers = [new Promise<Response>((r) => { release = r; }), mandate(1)];
		await ticks(1);
		expect(countReads).toBe(2);
		setVisibility('hidden');
		await becomeVisible();
		await ticks(2);
		expect(countReads).toBe(2);
		release(new Response(JSON.stringify({ pending: 7, viewer: 'owner' }), { status: 200 }));
		await settle();
		expect(getApprovalsBadge()).toBe(7);
	});

	it('counts the reads of an unnamed session as they go out, returns to the tab included', async () => {
		answers = [{ status: 500 }];
		stop = startApprovalsNav();
		await settle();
		for (let i = 0; i < 6; i++) {
			setVisibility('hidden');
			await becomeVisible();
		}
		await ticks(5);
		expect(countReads).toBe(1 + APPROVALS_COUNT_RETRIES);
	});

	it('asks again after a failed first read, so the owner still gets the item', async () => {
		answers = [{ status: 503 }, owner(2)];
		stop = startApprovalsNav();
		await settle();
		expect(approvalsNavItem()).toBeNull();
		await ticks(1);
		expect(getApprovalsViewer()).toBe('owner');
		expect(approvalsNavItem()?.badge).toBe(2);
	});

	it('asks a session nobody has named only a few more times when its reads keep failing', async () => {
		answers = [{ status: 500 }];
		stop = startApprovalsNav();
		await settle();
		await ticks(10);
		expect(countReads).toBe(1 + APPROVALS_COUNT_RETRIES);
		setVisibility('hidden');
		await becomeVisible();
		expect(countReads).toBe(1 + APPROVALS_COUNT_RETRIES);
	});

	it('a mount a newer one replaced records nothing and stops its own poll', async () => {
		let release!: (r: Response) => void;
		answers = [owner(3)];
		const older = startApprovalsNav();
		await settle();
		// A second mount starts before the first one stopped; its read has not come back.
		answers = [new Promise<Response>((r) => { release = r; })];
		stop = startApprovalsNav();
		await settle();
		// The older mount's poll fires and its owner answer comes back first.
		answers = [owner(9)];
		await ticks(1);
		expect(getApprovalsViewer()).toBeNull();
		expect(getApprovalsBadge()).toBeNull();
		const reads = countReads;
		await ticks(3);
		expect(countReads).toBe(reads);
		release(new Response(JSON.stringify({ pending: 1, viewer: 'mandate' }), { status: 200 }));
		await settle();
		expect(getApprovalsViewer()).toBe('mandate');
		older();
	});
});
