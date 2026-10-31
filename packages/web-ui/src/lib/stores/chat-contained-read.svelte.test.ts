// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Register 1112, ux U-091: a chat the engine refuses this reader (a contained chat that is neither
// theirs nor the owner's read) shows the reason in the page's language instead of an empty start
// page, and a copy the page kept from before is not shown. A refused live run says why too.

type Store = typeof import('./chat.svelte.js');

vi.mock('./toast.svelte.js', () => ({ addToast: () => 1 }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refused = (code: string): Response => json({ error: 'engine sentence', code }, 403);

let store: Store;
let calls: Array<{ url: string; body: unknown }>;

function serve(route: (url: string, body: unknown) => Response | undefined): void {
	calls = [];
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
		calls.push({ url, body });
		const r = route(url, body);
		if (r) return r;
		if (url.endsWith('/sessions')) return json({ sessionId: 'shop' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		return json({ messages: [], activeRun: null });
	}));
}

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('window', { addEventListener: () => {} });
	vi.resetModules();
	store = await import('./chat.svelte.js');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a chat the engine does not let this reader read', () => {
	// Opening a chat asks `POST /sessions` for it first; that is where the engine refuses it.
	const opening = (id: string) => (url: string, body: unknown): boolean =>
		url.endsWith('/sessions') && (body as { threadId?: string } | undefined)?.threadId === id;

	it('opening it shows why, keyed on the code, and no history', async () => {
		serve((url, body) => (opening('shop')(url, body) ? refused('contained_thread') : undefined));

		await store.resumeThread('shop');

		expect(store.getThreadReadRefusal()).toBe('contained.thread_read_refused');
		expect(store.getMessages()).toEqual([]);
		expect(store.getChatError(), 'the reason, not "could not open"').toBeNull();
		expect(calls.some((c) => c.url.includes('/threads/shop')), 'nothing read after the refusal').toBe(false);
	});

	it('a copy this page kept of the chat from before is not shown, and is dropped', async () => {
		// The page keeps chats it showed (localStorage) and shows that copy while it opens a chat.
		const kept: Record<string, string> = { 'lynox-chat': JSON.stringify({ sessionId: 'shop', threads: { shop: [{ role: 'user', content: 'Order 1042 for Jane' }] } }) };
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => { kept[k] = v; }, removeItem: (k: string) => { delete kept[k]; },
		});
		vi.resetModules();
		store = await import('./chat.svelte.js');
		serve((url, body) => (opening('shop')(url, body) ? refused('contained_thread') : undefined));

		await store.resumeThread('shop');

		expect(store.getThreadReadRefusal()).toBe('contained.thread_read_refused');
		expect(store.getMessages()).toEqual([]);
		expect(kept['lynox-chat'] ?? '').not.toContain('Order 1042');
	});

	it('the next message starts a new chat, and the reason goes', async () => {
		serve((url, body) => (opening('shop')(url, body) ? refused('contained_thread') : undefined));
		await store.resumeThread('shop');
		expect(store.getSessionId(), 'not attached to the refused chat').toBeNull();

		await store.sendMessage('Mach eine Liste', undefined, undefined, { typed: true });

		const opened = calls.filter((c) => c.url.endsWith('/sessions')).map((c) => (c.body as { threadId?: string } | undefined)?.threadId);
		expect(opened).toEqual(['shop', undefined]);
		expect(store.getThreadReadRefusal()).toBeNull();
	});

	it('another 403 on opening is not read as this refusal', async () => {
		serve((url, body) => (opening('shop')(url, body) ? json({ error: 'x', code: 'other' }, 403) : undefined));

		await store.resumeThread('shop');

		expect(store.getThreadReadRefusal()).toBeNull();
		expect(store.getChatError()).not.toBeNull();
	});

	it('a read refused after the chat opened shows the same reason', async () => {
		// The chat became contained between opening and reading it.
		serve((url) => (url.includes('/threads/shop/messages') ? refused('contained_thread') : undefined));

		await store.resumeThread('shop');

		expect(store.getThreadReadRefusal()).toBe('contained.thread_read_refused');
		expect(store.getMessages()).toEqual([]);
	});

	it('a chat it may read shows no refusal, and opening another clears an earlier one', async () => {
		serve((url, body) => (opening('shop')(url, body) ? refused('contained_thread') : undefined));
		await store.resumeThread('shop');
		expect(store.getThreadReadRefusal()).not.toBeNull();

		await store.resumeThread('notes');
		expect(store.getThreadReadRefusal()).toBeNull();
	});

	it('a live run it may not follow says so, and the history stays', async () => {
		serve((url) => {
			if (url.includes('/threads/mine/messages')) return json({ messages: [{ role: 'user', content: 'hi' }], activeRun: { runId: 'r1', status: 'running', lastPersistedSeq: 0 } });
			if (url.includes('/runs/r1/stream')) return refused('run_chat_unknown');
			return undefined;
		});

		await store.resumeThread('mine');
		for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));

		expect(store.getThreadReadRefusal()).toBe('contained.run_chat_unknown');
		expect(store.getMessages().map((m) => m.content)).toEqual(['hi']);
	});
});
