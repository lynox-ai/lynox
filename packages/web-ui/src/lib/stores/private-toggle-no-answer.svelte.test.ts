// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Both private-mode switches set their state before the request goes out. A request that gets no
// answer at all must take that back and say so: otherwise the switch shows private mode on while
// the server may never have stored it, and the chat keeps being captured.

const toasts: Array<{ message: string; type: string }> = [];
vi.mock('./toast.svelte.js', () => ({
	addToast: (message: string, type: string) => { toasts.push({ message, type }); return 1; },
}));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** `patch` answers the PATCH; everything else reads as a public chat t1 with nothing running. */
function serve(patch: () => Promise<Response>): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === 'PATCH') return patch();
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/threads/t1')) return json({ thread: { id: 't1', skip_extraction: 0 } });
		if (url.includes('/threads?') || url.endsWith('/threads')) return json({ threads: [{ id: 't1', title: 'T', message_count: 1, skip_extraction: 0 }] });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		return json({ messages: [], activeRun: null });
	}));
}

const offline = (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch'));
const stored = (): Promise<Response> => Promise.resolve(json({ ok: true }));

beforeEach(() => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('window', { addEventListener: () => {} });
	vi.resetModules();
	toasts.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the private switch in the chat header', () => {
	async function openChat(patch: () => Promise<Response>) {
		serve(patch);
		const store = await import('./chat.svelte.js');
		await store.resumeThread('t1');
		expect(store.getSkipExtraction()).toBe(false);
		return store;
	}

	it('stays off and says so when the request gets no answer', async () => {
		const store = await openChat(offline);
		await expect(store.toggleSkipExtraction()).resolves.toBeUndefined();
		expect(store.getSkipExtraction()).toBe(false);
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
	});

	it('turns on when the server stores it', async () => {
		// Control on the same path: only the answer differs from the case above.
		const store = await openChat(stored);
		await store.toggleSkipExtraction();
		expect(store.getSkipExtraction()).toBe(true);
		expect(toasts).toEqual([]);
	});
});

describe('the private switch in the thread list', () => {
	async function listThreads(patch: () => Promise<Response>) {
		serve(patch);
		const store = await import('./threads.svelte.js');
		await store.loadThreads();
		expect(store.getThreads().find((t) => t.id === 't1')?.skip_extraction).toBe(0);
		return store;
	}

	it('stays off and says so when the request gets no answer', async () => {
		const store = await listThreads(offline);
		await expect(store.toggleExtraction('t1')).resolves.toBeUndefined();
		expect(store.getThreads().find((t) => t.id === 't1')?.skip_extraction).toBe(0);
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
	});

	it('turns on when the server stores it', async () => {
		const store = await listThreads(stored);
		await store.toggleExtraction('t1');
		expect(store.getThreads().find((t) => t.id === 't1')?.skip_extraction).toBe(1);
		expect(toasts).toEqual([]);
	});
});
