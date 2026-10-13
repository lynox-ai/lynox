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
// BroadcastChannel, and a tab being left (`pagehide`) stops too. Stopping also cancels an
// ask still on its way. A refusal (401, 403) stops it; a server that cannot answer right
// now (a 5xx, the network) is not a refusal and leaves the one further try standing.

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
	/** Whether it has stopped; a stopped timer is replaced on the next install. */
	readonly stopped: boolean;
	/** The first ask, made on start; settles when its answer is handled. */
	ready: Promise<void>;
}

export function startMandateRenewTimer(deps: RenewTimerDeps): RenewTimer {
	let stopped = false;
	let handle: unknown = null;
	let knownExp: number | null = null;
	const inFlight = new Set<AbortController>();

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
			if (answer.exp - RENEW_LEAD_S > now) { plan(answer.exp - RENEW_LEAD_S); return; }
		}
		// The one further try: there is a single point for it, so asking again before it
		// (a tab coming back) plans the same point, and after it nothing is left to plan.
		if (answer.exp - RETRY_LEAD_S > now) plan(answer.exp - RETRY_LEAD_S);
	};

	const ask = async (): Promise<void> => {
		if (stopped) return;
		let answer: RenewAnswer;
		const controller = new AbortController();
		inFlight.add(controller);
		try {
			const res = await deps.fetchImpl('/auth/renew', { method: 'POST', credentials: 'same-origin', signal: controller.signal });
			if (res.status === 401 || res.status === 403) { stop(false); return; }
			if (!res.ok) throw new Error(`renew answered ${res.status}`);
			answer = await res.json() as RenewAnswer;
		} catch {
			// Unreachable is not a refusal: the one further try still stands. Before any answer
			// there is no end to plan for; a tab coming back asks again.
			if (!stopped && knownExp !== null) apply({ kind: 'mandate', exp: knownExp, renewed: false });
			return;
		} finally {
			inFlight.delete(controller);
		}
		if (!stopped) apply(answer);
	};

	const onVisible = (): void => { if (deps.target.visibilityState === 'visible') void ask(); };
	const onPageHide = (): void => {
		stop(false);
		deps.pageEvents.removeEventListener('pagehide', onPageHide);
		deps.channel?.close();
	};

	const stop = (announce = false): void => {
		// The channel stays open until the page is left, so a timer that already stopped
		// (the owner's, or after a refusal) still tells the other tabs of a logout.
		if (announce) {
			try { deps.channel?.postMessage(LOGOUT_MESSAGE); } catch { /* closed: the page is being left */ }
		}
		if (stopped) return;
		stopped = true;
		// Every ask still on its way, not only the newest: a tab coming back asks beside a planned one.
		for (const c of inFlight) c.abort();
		inFlight.clear();
		if (handle !== null) deps.clearTimer(handle);
		handle = null;
		deps.target.removeEventListener('visibilitychange', onVisible);
	};

	deps.target.addEventListener('visibilitychange', onVisible);
	deps.pageEvents.addEventListener('pagehide', onPageHide);
	deps.channel?.addEventListener('message', (e) => { if (e.data === LOGOUT_MESSAGE) stop(false); });

	return { stop, get stopped() { return stopped; }, ready: ask() };
}

declare global {
	interface Window { __lynoxRenewTimer?: RenewTimer; __lynoxRenewPageShow?: boolean }
}

/**
 * Installs the timer once per page (a `window` sentinel survives HMR, like the fetch
 * interceptor). A stopped one stays stopped, except on a page restored from the back-forward
 * cache: its `pagehide` stopped it, and it asks again (`afterRestore`).
 */
export function installMandateRenewTimer(afterRestore = false): RenewTimer | null {
	if (typeof window === 'undefined') return null;
	const current = window.__lynoxRenewTimer;
	if (current && !(afterRestore && current.stopped)) return current;
	if (!window.__lynoxRenewPageShow) {
		window.__lynoxRenewPageShow = true;
		window.addEventListener('pageshow', (e) => { if (e.persisted) installMandateRenewTimer(true); });
	}
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
