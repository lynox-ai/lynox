// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The private switch in the chat header sets its state before the request goes out. A request
// that gets no answer at all leaves the server's state unknown, in either direction, so the
// switch shows OFF and says the change failed: showing private mode on while the server may hold
// it off is the one picture that lets a chat be remembered while the user thinks it is not.

const toasts: Array<{ message: string; type: string }> = [];
vi.mock('./toast.svelte.js', () => ({
	addToast: (message: string, type: string) => { toasts.push({ message, type }); return 1; },
}));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Chat t1 opens with `skip` stored; `patch` answers the switch. */
function serve(skip: 0 | 1, patch: () => Promise<Response>): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === 'PATCH') return patch();
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/threads/t1')) return json({ thread: { id: 't1', skip_extraction: skip } });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.includes('/threads')) return json({ threads: [] });
		return json({ messages: [], activeRun: null });
	}));
}

const offline = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));

async function openChat(skip: 0 | 1, patch: () => Promise<Response>) {
	serve(skip, patch);
	const store = await import('./chat.svelte.js');
	await store.resumeThread('t1');
	expect(store.getSkipExtraction()).toBe(skip === 1);
	return store;
}

beforeEach(() => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('window', { addEventListener: () => {} });
	vi.resetModules();
	toasts.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the private switch in the chat header, when its request gets no answer', () => {
	it('switching on: shows off and says so', async () => {
		const store = await openChat(0, offline);
		await expect(store.toggleSkipExtraction()).resolves.toBeUndefined();
		expect(store.getSkipExtraction()).toBe(false);
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
	});

	it('switching off: shows off too, not the private mode it came from', async () => {
		// The server may have stored the switch-off before the answer was lost. Falling back to
		// the previous state here would show private mode on over a chat that is being remembered.
		const store = await openChat(1, offline);
		await store.toggleSkipExtraction();
		expect(store.getSkipExtraction()).toBe(false);
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
	});
});

describe('controls on the same path', () => {
	it('turns on when the server stores it', async () => {
		const store = await openChat(0, () => Promise.resolve(json({ ok: true })));
		await store.toggleSkipExtraction();
		expect(store.getSkipExtraction()).toBe(true);
		expect(toasts).toEqual([]);
	});

	it('an answer that names the stored state still wins over "off": a failed purge keeps private mode on', async () => {
		// Only the no-answer branch shows off unconditionally; an answer keeps its own rule.
		const store = await openChat(0, () => Promise.resolve(json({ error: 'x', skip_extraction: true }, 500)));
		await store.toggleSkipExtraction();
		expect(store.getSkipExtraction()).toBe(true);
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
	});
});
