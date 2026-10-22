// The approval queue's place in the navigation: whether it exists here, and how many mails wait.
//
// `GET /api/approvals/count` answers 404 while the queue is off; the nav item shows only after an
// ok answer. The count is asked once on mount by every session (that one answer decides whether
// the item shows), and polled afterwards only in the owner's session: only the owner decides, and
// every read a mandate's session makes is written to the owner's trail. Whose session this is
// comes from the session-renewal answer (`mandate-renew-timer.ts`); a session it does not name
// (no answer, a refusal) is not polled.

import { getApiBase } from '../config.svelte.js';

export type SessionPrincipal = 'owner' | 'mandate' | null;

/** How often the owner's session asks for the count while the page is open. */
export const APPROVALS_COUNT_POLL_MS = 30_000;

let enabled = $state(false);
let pending = $state<number | null>(null);
let principal = $state<SessionPrincipal>(null);

/** Whether the queue is on here (the count route answered ok). */
export function getApprovalsEnabled(): boolean {
	return enabled;
}

/** Whose session this is, once known. */
export function getApprovalsPrincipal(): SessionPrincipal {
	return principal;
}

/** The nav badge: the number of mails waiting for a decision (`pending` only), for the owner's
 *  session, or null when there is nothing to show. */
export function getApprovalsBadge(): number | null {
	return enabled && principal === 'owner' && pending !== null && pending > 0 ? pending : null;
}

/** The count a list answer carried, so the badge follows a decision without another request. */
export function setApprovalsPending(n: number): void {
	if (Number.isInteger(n) && n >= 0) pending = n;
}

async function readCount(): Promise<void> {
	try {
		const res = await fetch(`${getApiBase()}/approvals/count`);
		enabled = res.ok;
		if (!res.ok) { pending = null; return; }
		const body = (await res.json()) as { pending?: unknown };
		pending = typeof body.pending === 'number' && Number.isInteger(body.pending) && body.pending >= 0 ? body.pending : null;
	} catch {
		// Unreachable: the item stays as it was; the next ask tells.
	}
}

/**
 * Asks once whether the queue is on, then, once `whoseSession` says it is the owner's, keeps the
 * count current: every `intervalMs` and when the tab comes back to the foreground. Returns a stop
 * function.
 */
export function startApprovalsNav(whoseSession: Promise<SessionPrincipal>, intervalMs = APPROVALS_COUNT_POLL_MS): () => void {
	let stopped = false;
	let stopPoll: (() => void) | null = null;
	void readCount();
	void whoseSession.then((p) => {
		principal = p;
		if (stopped || p !== 'owner') return;
		const timer = setInterval(() => { if (enabled) void readCount(); }, intervalMs);
		const onVisible = (): void => { if (document.visibilityState === 'visible' && enabled) void readCount(); };
		document.addEventListener('visibilitychange', onVisible);
		stopPoll = () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	}, () => { principal = null; });
	return () => {
		stopped = true;
		stopPoll?.();
		stopPoll = null;
	};
}

/** Test seam: back to the state before any probe. */
export function resetApprovalsNavForTest(): void {
	enabled = false;
	pending = null;
	principal = null;
}
