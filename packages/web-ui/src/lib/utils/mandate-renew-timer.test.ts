import { afterEach, describe, it, expect, vi } from 'vitest';
import { installMandateRenewTimer, startMandateRenewTimer, LOGOUT_MESSAGE, type RenewTimerDeps } from './mandate-renew-timer.js';

const T = 2_000_000_000;

type Answer = { status: number; body?: unknown } | Error | 'hold';

/** A clock, a timer queue, listeners and a channel the test drives by hand. */
function harness(answers: Answer[]) {
	let now = T;
	const timers: Array<{ id: number; fn: () => void; atMs: number } | null> = [];
	const listeners = new Map<string, () => void>();
	const pageListeners = new Map<string, () => void>();
	let channelListener: ((e: MessageEvent) => void) | null = null;
	const target = { visibilityState: 'visible' as DocumentVisibilityState };
	const signals: AbortSignal[] = [];
	const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		signals.push(init.signal!);
		const a = answers.shift();
		if (a === 'hold') {
			// Never answers on its own: settles only when aborted.
			return new Promise<Response>((_r, reject) => { init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
		}
		if (a === undefined) throw new Error('no answer queued');
		if (a instanceof Error) throw a;
		return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
	});
	let closed = false;
	// Like a real BroadcastChannel: posting after close throws.
	const channel = {
		postMessage: vi.fn(() => { if (closed) throw new DOMException('BroadcastChannel is closed', 'InvalidStateError'); }),
		addEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => { channelListener = fn; },
		close: vi.fn(() => { closed = true; }),
	};
	const deps: RenewTimerDeps = {
		fetchImpl: fetchImpl as unknown as typeof fetch,
		nowS: () => now,
		setTimer: (fn, ms) => { timers.push({ id: timers.length, fn, atMs: now * 1000 + ms }); return timers.length - 1; },
		clearTimer: (h) => { timers[h as number] = null; },
		target: {
			get visibilityState() { return target.visibilityState; },
			addEventListener: (t: string, fn: () => void) => { listeners.set(t, fn); },
			removeEventListener: (t: string) => { listeners.delete(t); },
		} as unknown as RenewTimerDeps['target'],
		pageEvents: {
			addEventListener: (t: string, fn: () => void) => { pageListeners.set(t, fn); },
			removeEventListener: (t: string) => { pageListeners.delete(t); },
		} as unknown as RenewTimerDeps['pageEvents'],
		channel,
	};
	const pending = () => timers.filter((t): t is NonNullable<typeof t> => t !== null);
	return {
		deps, fetchImpl, channel, listeners, pageListeners, target, signals,
		/** Unix seconds of the one planned ask, or null. */
		plannedAtS: () => { const p = pending(); expect(p.length).toBeLessThanOrEqual(1); return p[0] ? p[0].atMs / 1000 : null; },
		/** Move the clock to the planned ask and run it. */
		async fire() {
			const p = pending()[0];
			if (!p) throw new Error('nothing planned');
			now = p.atMs / 1000;
			timers[p.id] = null;
			p.fn();
			await flush();
		},
		setNow: (s: number) => { now = s; },
		message: (data: unknown) => channelListener?.({ data } as MessageEvent),
	};
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const mandate = (exp: number, renewed = false) => ({ status: 200, body: { kind: 'mandate', exp, renewed } });

describe('startMandateRenewTimer', () => {
	it('asks once on start and stops for good for the owner', async () => {
		const h = harness([{ status: 200, body: { kind: 'owner' } }]);
		const timer = startMandateRenewTimer(h.deps);
		await timer.ready;
		expect(h.fetchImpl).toHaveBeenCalledTimes(1);
		expect(h.fetchImpl).toHaveBeenCalledWith('/auth/renew', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
		expect(h.plannedAtS()).toBeNull();
		expect(h.listeners.size).toBe(0);
		expect(timer.stopped).toBe(true);
	});

	it('still tells the other tabs of a logout after it stopped, and never throws doing so', async () => {
		const h = harness([{ status: 200, body: { kind: 'owner' } }]);
		const timer = startMandateRenewTimer(h.deps);
		await timer.ready;
		expect(h.channel.close).not.toHaveBeenCalled();
		timer.stop(true);
		expect(h.channel.postMessage).toHaveBeenCalledWith(LOGOUT_MESSAGE);
		// Once the page is left the channel is closed; a logout then must not throw.
		h.pageListeners.get('pagehide')!();
		expect(h.channel.close).toHaveBeenCalled();
		expect(() => timer.stop(true)).not.toThrow();
	});

	it('plans the next ask four minutes before the end, and again after each renewal', async () => {
		const h = harness([mandate(T + 900), mandate(T + 900 + 660, true)]);
		await startMandateRenewTimer(h.deps).ready;
		expect(h.plannedAtS()).toBe(T + 900 - 240);
		await h.fire();
		expect(h.plannedAtS()).toBe(T + 900 + 660 - 240);
	});

	it('tries once more a minute before the end when a renewal did not happen, then leaves it to the end', async () => {
		const h = harness([mandate(T + 900), mandate(T + 900), mandate(T + 900)]);
		await startMandateRenewTimer(h.deps).ready;
		await h.fire();
		expect(h.plannedAtS()).toBe(T + 900 - 60);
		await h.fire();
		expect(h.plannedAtS()).toBeNull();
		expect(h.fetchImpl).toHaveBeenCalledTimes(3);
	});

	it('keeps the further try when the server cannot be reached', async () => {
		const h = harness([mandate(T + 900), new TypeError('offline')]);
		await startMandateRenewTimer(h.deps).ready;
		await h.fire();
		expect(h.plannedAtS()).toBe(T + 900 - 60);
	});

	it('plans nothing when the first ask cannot reach the server', async () => {
		const h = harness([new TypeError('offline')]);
		await startMandateRenewTimer(h.deps).ready;
		expect(h.plannedAtS()).toBeNull();
		expect(h.listeners.has('visibilitychange')).toBe(true);
	});

	it('starts a fresh round when another tab renewed', async () => {
		const h = harness([mandate(T + 900), mandate(T + 900), mandate(T + 900 + 660), mandate(T + 900 + 660)]);
		await startMandateRenewTimer(h.deps).ready;
		await h.fire(); // not renewed here: the one retry is planned
		expect(h.plannedAtS()).toBe(T + 900 - 60);
		// Back in the foreground, it learns of the later end another tab got.
		h.listeners.get('visibilitychange')!();
		await flush();
		expect(h.plannedAtS()).toBe(T + 900 + 660 - 240);
		// The fresh round has its own further try.
		await h.fire();
		expect(h.plannedAtS()).toBe(T + 900 + 660 - 60);
	});

	it('asks when the tab comes back to the foreground, not when it leaves it', async () => {
		const h = harness([mandate(T + 900), mandate(T + 900)]);
		await startMandateRenewTimer(h.deps).ready;
		h.target.visibilityState = 'hidden';
		h.listeners.get('visibilitychange')!();
		await flush();
		expect(h.fetchImpl).toHaveBeenCalledTimes(1);
		h.target.visibilityState = 'visible';
		h.listeners.get('visibilitychange')!();
		await flush();
		expect(h.fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('keeps the further try when the server answers with an error of its own', async () => {
		const h = harness([mandate(T + 900), { status: 502 }]);
		const timer = startMandateRenewTimer(h.deps);
		await timer.ready;
		await h.fire();
		expect(h.plannedAtS()).toBe(T + 900 - 60);
		expect(timer.stopped).toBe(false);
	});

	it('cancels an ask still on its way when it stops', async () => {
		const h = harness([mandate(T + 900), 'hold']);
		const timer = startMandateRenewTimer(h.deps);
		await timer.ready;
		await h.fire();
		expect(h.signals[1]!.aborted).toBe(false);
		h.message(LOGOUT_MESSAGE);
		expect(h.signals[1]!.aborted).toBe(true);
		await flush();
		expect(h.plannedAtS()).toBeNull();
	});

	it('cancels every ask still on its way, also one a returning tab started beside a planned one', async () => {
		const h = harness([mandate(T + 900), 'hold', 'hold']);
		await startMandateRenewTimer(h.deps).ready;
		await h.fire();
		h.listeners.get('visibilitychange')!();
		await flush();
		expect(h.signals).toHaveLength(3);
		h.message(LOGOUT_MESSAGE);
		expect(h.signals[1]!.aborted).toBe(true);
		expect(h.signals[2]!.aborted).toBe(true);
	});

	it('stops on a refusal, and never plans past the end', async () => {
		for (const refusal of [401, 403]) {
			const h = harness([mandate(T + 900), { status: refusal }]);
			await startMandateRenewTimer(h.deps).ready;
			await h.fire();
			expect(h.plannedAtS(), String(refusal)).toBeNull();
			expect(h.listeners.size).toBe(0);
		}
		const ended = harness([mandate(T)]);
		await startMandateRenewTimer(ended.deps).ready;
		expect(ended.plannedAtS()).toBeNull();
		expect(ended.listeners.size).toBe(0);
	});

	it('on the four-minute mark itself, plans the further try instead of asking again at once', async () => {
		const h = harness([mandate(T + 240)]);
		await startMandateRenewTimer(h.deps).ready;
		expect(h.plannedAtS()).toBe(T + 240 - 60);
	});

	it('plans the retry at once when the end is already inside the four minutes', async () => {
		const h = harness([mandate(T + 200)]);
		await startMandateRenewTimer(h.deps).ready;
		expect(h.plannedAtS()).toBe(T + 200 - 60);
	});

	it('stops when the page is left', async () => {
		const h = harness([mandate(T + 900)]);
		await startMandateRenewTimer(h.deps).ready;
		h.pageListeners.get('pagehide')!();
		expect(h.plannedAtS()).toBeNull();
		expect(h.channel.postMessage).not.toHaveBeenCalled();
	});

	it('logout stops it here and tells every other tab, which stops on hearing it', async () => {
		const here = harness([mandate(T + 900)]);
		const timer = startMandateRenewTimer(here.deps);
		await timer.ready;
		timer.stop(true);
		expect(here.channel.postMessage).toHaveBeenCalledWith(LOGOUT_MESSAGE);
		expect(here.plannedAtS()).toBeNull();

		const other = harness([mandate(T + 900)]);
		await startMandateRenewTimer(other.deps).ready;
		other.message('something else');
		expect(other.plannedAtS()).toBe(T + 900 - 240);
		other.message(LOGOUT_MESSAGE);
		expect(other.plannedAtS()).toBeNull();
		expect(other.listeners.size).toBe(0);
	});

	it('does not act on an answer that arrives after it was stopped', async () => {
		const h = harness([mandate(T + 900)]);
		const timer = startMandateRenewTimer(h.deps);
		timer.stop(false);
		await timer.ready;
		expect(h.plannedAtS()).toBeNull();
	});
});

describe('installMandateRenewTimer', () => {
	afterEach(() => { vi.unstubAllGlobals(); });

	function stubPage(answer: unknown) {
		const pageListeners = new Map<string, (e: unknown) => void>();
		const win = {
			fetch: vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 })),
			setTimeout: () => 0,
			clearTimeout: () => {},
			addEventListener: (t: string, fn: (e: unknown) => void) => { pageListeners.set(t, fn); },
			removeEventListener: () => {},
		} as unknown as Window;
		vi.stubGlobal('window', win);
		vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
		return { win, pageListeners };
	}

	it('installs once, keeps a stopped one stopped, and replaces it only on a return from the back-forward cache', async () => {
		const { win, pageListeners } = stubPage({ kind: 'mandate', exp: Math.floor(Date.now() / 1000) + 900, renewed: false });
		const first = installMandateRenewTimer()!;
		await first.ready;
		expect(installMandateRenewTimer()).toBe(first);
		pageListeners.get('pagehide')!({});
		expect(first.stopped).toBe(true);
		// A remount of the shell does not start it again, and neither does a fresh page show.
		expect(installMandateRenewTimer()).toBe(first);
		pageListeners.get('pageshow')!({ persisted: false });
		expect(win.__lynoxRenewTimer).toBe(first);
		expect(win.fetch).toHaveBeenCalledTimes(1);
		pageListeners.get('pageshow')!({ persisted: true });
		const second = win.__lynoxRenewTimer!;
		expect(second).not.toBe(first);
		await second.ready;
		expect(second.stopped).toBe(false);
		second.stop(false);
	});
});
