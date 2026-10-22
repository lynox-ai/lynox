// The approval queue's place in the navigation: whether it exists here, and how many mails wait.
//
// `GET /api/approvals/count` answers 404 while the queue is off, and otherwise says whose session
// asked (`viewer`: `owner`, `mandate`, or `none` for a session it cannot name). The count is asked
// once on mount by every session; that answer decides whether the item shows. It is polled
// afterwards only while the latest answer names the owner: only the owner decides, and every read
// a mandate's session makes is written to the owner's trail. Whose session this is is read from
// the answers of the current mount only: the cookie is shared by all tabs, so a login in another
// tab, or on this one without a reload, changes it under an open page.

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

type CountAnswer = { kind: 'off' } | { kind: 'failed' } | { kind: 'answer'; viewer: ApprovalsViewer; pending: number | null };

/**
 * Asks for the count once. Writes nothing: the caller decides whether the answer is still the
 * latest one before it records it.
 *
 * Only a 404 means the queue is off. Anything else that is not an answer (any other refusal, a
 * network error, a body that does not parse) is `failed`. An answer without a known `viewer` (an
 * engine older than the field) counts as `none`.
 */
async function readCount(): Promise<CountAnswer> {
	let res: Response;
	try {
		res = await fetch(`${getApiBase()}/approvals/count`);
	} catch {
		return { kind: 'failed' };
	}
	if (res.status === 404) return { kind: 'off' };
	if (!res.ok) return { kind: 'failed' };
	let body: { pending?: unknown; viewer?: unknown };
	try {
		body = (await res.json()) as { pending?: unknown; viewer?: unknown };
	} catch {
		return { kind: 'failed' };
	}
	return {
		kind: 'answer',
		viewer: typeof body.viewer === 'string' && VIEWERS.has(body.viewer) ? body.viewer as ApprovalsViewer : 'none',
		pending: typeof body.pending === 'number' && Number.isInteger(body.pending) && body.pending >= 0 ? body.pending : null,
	};
}

/** How often a mount that has had no answer yet asks again on the poll interval. */
export const APPROVALS_COUNT_RETRIES = 3;

/** Bumped by every start, so an answer to an earlier mount is never recorded. */
let generation = 0;

/**
 * Asks once, then keeps the count current while the latest answer names the owner: every
 * `intervalMs` and when the tab comes back to the foreground. An answer naming anyone else, or a
 * queue that is off, stops the poll; an owner answer (re)starts it. Until this mount has had an
 * answer at all, a failed read is asked again on the same interval, at most
 * `APPROVALS_COUNT_RETRIES` times, so one failed first read does not leave the owner without the
 * item.
 *
 * Whose session it is starts unknown on every mount: the page can outlive a session (a login
 * without a reload), so nothing an earlier mount learned is shown before this one has an answer.
 * Only the latest mount records an answer, and it has one read out at a time. Returns a stop
 * function.
 */
export function startApprovalsNav(intervalMs = APPROVALS_COUNT_POLL_MS): () => void {
	const mount = ++generation;
	viewer = null;
	pending = null;
	let stopped = false;
	let reading = false;
	let sent = 0;
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
		// One read at a time: a tick or a return to the tab while one runs asks nothing.
		if (reading) return;
		reading = true;
		sent++;
		let answer: CountAnswer;
		try {
			answer = await readCount();
		} finally {
			reading = false;
		}
		if (mount !== generation) { stopPoll(); return; }
		if (stopped) return;
		if (answer.kind === 'off') {
			enabled = false;
			pending = null;
			viewer = null;
			stopPoll();
			return;
		}
		if (answer.kind === 'failed') {
			// A count that was not confirmed is not shown; the item and whose session it was stay.
			pending = null;
			if (viewer === null) {
				// Every read a mandate's session makes is on the owner's trail, also one the route then
				// fails; so a session nobody has named yet sends only a few. With one read out at a time,
				// counting reads sent counts every request, returns to the tab included.
				if (sent <= APPROVALS_COUNT_RETRIES) startPoll();
				else stopPoll();
			}
			return;
		}
		enabled = true;
		viewer = answer.viewer;
		pending = answer.pending;
		if (answer.viewer === 'owner') startPoll();
		else stopPoll();
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
