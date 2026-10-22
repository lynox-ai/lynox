// The approval queue's place in the navigation: whether it exists here, and how many mails wait.
//
// `GET /api/approvals/count` answers 404 while the queue is off, and otherwise says whose session
// asked (`viewer`: `owner`, `mandate`, or `none` for a session it cannot name). The count is asked
// once on mount by every session; that answer decides whether the item shows. It is polled
// afterwards only while the latest answer names the owner: only the owner decides, and every read
// a mandate's session makes is written to the owner's trail. Whose session this is is read from
// every answer, never kept from an earlier one: the cookie is shared by all tabs, so a login in
// another tab, or on this one without a reload, changes it under an open page.

import { getApiBase } from '../config.svelte.js';

export type ApprovalsViewer = 'owner' | 'mandate' | 'none';

/** How often the owner's session asks for the count while the page is open. */
export const APPROVALS_COUNT_POLL_MS = 30_000;

let enabled = $state(false);
let pending = $state<number | null>(null);
let viewer = $state<ApprovalsViewer | null>(null);

/** Whether the queue is on here (the count route answered ok). */
export function getApprovalsEnabled(): boolean {
	return enabled;
}

/** Whose session the latest count answer named, or null before one. */
export function getApprovalsViewer(): ApprovalsViewer | null {
	return viewer;
}

/** The nav badge: the number of mails waiting for a decision (`pending` only), while the latest
 *  answer named the owner, or null when there is nothing to show. */
export function getApprovalsBadge(): number | null {
	return enabled && viewer === 'owner' && pending !== null && pending > 0 ? pending : null;
}

/** The count a list answer carried, so the badge follows a decision without another request. */
export function setApprovalsPending(n: number): void {
	if (Number.isInteger(n) && n >= 0) pending = n;
}

/** The shell's nav entry for the queue, or null while the queue is off here. */
export function approvalsNavItem(): { href: string; labelKey: string; exact: boolean; icon: 'send'; badge: number | null } | null {
	return enabled ? { href: '/app/approvals', labelKey: 'nav.approvals', exact: false, icon: 'send', badge: getApprovalsBadge() } : null;
}

const VIEWERS: ReadonlySet<string> = new Set(['owner', 'mandate', 'none']);

/**
 * Asks for the count once and records the answer. Returns whose session it named, `off` when the
 * queue is off (404), or null when it could not tell (any other refusal, a network error).
 *
 * Only a 404 hides the item. Anything else that is not an answer keeps the item and whose session
 * it was, and hides the badge until the next answer: a count that was not confirmed is not shown.
 * An answer without a known `viewer` (an engine older than the field) counts as `none`.
 */
async function readCount(): Promise<ApprovalsViewer | 'off' | null> {
	let res: Response;
	try {
		res = await fetch(`${getApiBase()}/approvals/count`);
	} catch {
		pending = null;
		return null;
	}
	if (res.status === 404) {
		enabled = false;
		pending = null;
		viewer = null;
		return 'off';
	}
	if (!res.ok) {
		pending = null;
		return null;
	}
	let body: { pending?: unknown; viewer?: unknown };
	try {
		body = (await res.json()) as { pending?: unknown; viewer?: unknown };
	} catch {
		pending = null;
		return null;
	}
	enabled = true;
	viewer = typeof body.viewer === 'string' && VIEWERS.has(body.viewer) ? body.viewer as ApprovalsViewer : 'none';
	pending = typeof body.pending === 'number' && Number.isInteger(body.pending) && body.pending >= 0 ? body.pending : null;
	return viewer;
}

/**
 * Asks once, then keeps the count current while the latest answer names the owner: every
 * `intervalMs` and when the tab comes back to the foreground. An answer naming anyone else, or a
 * queue that is off, stops the poll; an owner answer (re)starts it. Returns a stop function.
 */
export function startApprovalsNav(intervalMs = APPROVALS_COUNT_POLL_MS): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | null = null;
	const onVisible = (): void => { if (document.visibilityState === 'visible') void ask(); };

	const startPoll = (): void => {
		if (timer !== null) return;
		timer = setInterval(() => { void ask(); }, intervalMs);
		document.addEventListener('visibilitychange', onVisible);
	};
	const stopPoll = (): void => {
		if (timer !== null) clearInterval(timer);
		timer = null;
		document.removeEventListener('visibilitychange', onVisible);
	};

	async function ask(): Promise<void> {
		const answer = await readCount();
		if (stopped) return;
		if (answer === 'owner') startPoll();
		else if (answer !== null) stopPoll();
	}

	void ask();
	return () => {
		stopped = true;
		stopPoll();
	};
}

/** Test seam: back to the state before any probe. */
export function resetApprovalsNavForTest(): void {
	enabled = false;
	pending = null;
	viewer = null;
}
