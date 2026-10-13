// === Renewal of a mandate session from the browser (POST /auth/renew) ===
//
// Installed once from AppShell on mount. The session cookie is httpOnly, so the page learns its
// end only from `/auth/renew` itself: asked once on mount, it answers `owner` (and the timer
// stops for good) or the mandate session's `exp`. The next ask is planned inside the server's
// renewal window, four minutes before `exp`, and once more a minute before `exp` when that one
// did not renew. Never after `exp`: an ended session is reported by the next `/api/*` 401, as
// before. A tab coming back to the foreground asks at once, because browsers slow timers in the
// background.
//
// Logout stops it in every tab of this origin: the logout link announces itself on a
// BroadcastChannel, and a tab being left (`pagehide`) stops too.

/** The server's renewal window is five minutes; plan inside it. */
export const RENEW_LEAD_S = 4 * 60;
/** The one further try when a renewal did not happen. */
export const RETRY_LEAD_S = 60;
export const SESSION_CHANNEL = 'lynox-session';
export const LOGOUT_MESSAGE = 'logout';

type RenewAnswer = { kind: 'owner' } | { kind: 'mandate'; exp: number; renewed: boolean };

export interface RenewTimerDeps {
	fetchImpl: typeof fetch;
	nowS: () => number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	/** Where `visibilitychange` and `pagehide` are listened for. */
	target: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
	pageEvents: Pick<Window, 'addEventListener' | 'removeEventListener'>;
	channel: { postMessage(m: unknown): void; addEventListener(t: 'message', fn: (e: MessageEvent) => void): void; close(): void } | null;
}

export interface RenewTimer {
	/** Stop asking, here and (when `announce`) in every other tab of this origin. */
	stop(announce?: boolean): void;
	/** The first ask, made on start; settles when its answer is handled. */
	ready: Promise<void>;
}

export function startMandateRenewTimer(deps: RenewTimerDeps): RenewTimer {
	let stopped = false;
	let handle: unknown = null;
	let knownExp: number | null = null;
	let retried = false;

	const plan = (atS: number): void => {
		if (handle !== null) deps.clearTimer(handle);
		handle = deps.setTimer(() => { handle = null; void ask(); }, Math.max(0, (atS - deps.nowS()) * 1000));
	};

	const apply = (answer: RenewAnswer): void => {
		if (answer.kind === 'owner') { stop(false); return; }
		const now = deps.nowS();
		if (now >= answer.exp) { stop(false); return; }
		// A later end, renewed here or by another tab, starts a fresh round.
		if (knownExp === null || answer.exp > knownExp) {
			knownExp = answer.exp;
			retried = false;
			if (answer.exp - RENEW_LEAD_S > now) { plan(answer.exp - RENEW_LEAD_S); return; }
		}
		if (!retried && answer.exp - RETRY_LEAD_S > now) {
			retried = true;
			plan(answer.exp - RETRY_LEAD_S);
		}
	};

	const ask = async (): Promise<void> => {
		if (stopped) return;
		let answer: RenewAnswer;
		try {
			const res = await deps.fetchImpl('/auth/renew', { method: 'POST', credentials: 'same-origin' });
			if (!res.ok) { stop(false); return; }
			answer = await res.json() as RenewAnswer;
		} catch {
			// Unreachable is not a refusal: the one further try still stands. Before any answer
			// there is no end to plan for; a tab coming back asks again.
			if (!stopped && knownExp !== null) apply({ kind: 'mandate', exp: knownExp, renewed: false });
			return;
		}
		if (!stopped) apply(answer);
	};

	const onVisible = (): void => { if (deps.target.visibilityState === 'visible') void ask(); };
	const onPageHide = (): void => stop(false);

	const stop = (announce = false): void => {
		if (announce) deps.channel?.postMessage(LOGOUT_MESSAGE);
		if (stopped) return;
		stopped = true;
		if (handle !== null) deps.clearTimer(handle);
		handle = null;
		deps.target.removeEventListener('visibilitychange', onVisible);
		deps.pageEvents.removeEventListener('pagehide', onPageHide);
		deps.channel?.close();
	};

	deps.target.addEventListener('visibilitychange', onVisible);
	deps.pageEvents.addEventListener('pagehide', onPageHide);
	deps.channel?.addEventListener('message', (e) => { if (e.data === LOGOUT_MESSAGE) stop(false); });

	return { stop, ready: ask() };
}

declare global {
	interface Window { __lynoxRenewTimer?: RenewTimer }
}

/** Installs the timer once per page (a `window` sentinel survives HMR, like the fetch interceptor). */
export function installMandateRenewTimer(): RenewTimer | null {
	if (typeof window === 'undefined') return null;
	if (window.__lynoxRenewTimer) return window.__lynoxRenewTimer;
	const timer = startMandateRenewTimer({
		fetchImpl: window.fetch.bind(window),
		nowS: () => Math.floor(Date.now() / 1000),
		setTimer: (fn, ms) => window.setTimeout(fn, ms),
		clearTimer: (h) => window.clearTimeout(h as number),
		target: document,
		pageEvents: window,
		channel: typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(SESSION_CHANNEL),
	});
	window.__lynoxRenewTimer = timer;
	return timer;
}
