import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// After a reload the chat holds its id (kept in this browser) and reads its transcript back; no
// session is opened. The tier that shows the model row and picker comes from the thread's record.

type Store = typeof import('./chat.svelte.js');

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;
/** What `/threads/t1` says. */
let thread: Record<string, unknown> | null;
/** Holds the `/threads/t1` read until it settles, when set. */
let threadHold: Promise<void> | null;
let threadReads = 0;

/** A page that reloads with chat `t1` open, as this browser kept it. */
async function reload(): Promise<void> {
	const kept: Record<string, string> = { 'lynox-chat': JSON.stringify({ sessionId: 't1', threads: { t1: [] } }) };
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => kept[k] ?? null,
		setItem: (k: string, v: string) => { kept[k] = v; },
		removeItem: (k: string) => { delete kept[k]; },
	});
	vi.resetModules();
	store = await import('./chat.svelte.js');
}

beforeEach(() => {
	vi.stubGlobal('navigator', { onLine: true });
	thread = { id: 't1', model_tier: 'deep', skip_extraction: 0 };
	threadHold = null;
	threadReads = 0;
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/threads/t1')) {
			threadReads++;
			if (threadHold) { const hold = threadHold; threadHold = null; await hold; }
			return thread === null ? json({ thread: null, threadMissing: true }) : json({ thread: { ...thread } });
		}
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		return json({}, 404);
	}));
});

afterEach(() => {
	store.newChat();
	vi.unstubAllGlobals();
});

describe('the chat\'s tier after a reload', () => {
	it('is read back from the thread\'s record, so the model row and picker show again', async () => {
		await reload();
		expect(store.getSessionId()).toBe('t1');
		expect(store.getSessionTier()).toBeNull();
		await store.reconcileThread();
		await settle();
		expect(store.getSessionTier()).toBe('deep');
	});

	it('stays unknown for a chat whose record is gone or carries no tier', async () => {
		thread = null;
		await reload();
		await store.reconcileThread();
		await settle();
		expect(store.getSessionTier()).toBeNull();
		thread = { id: 't1', model_tier: '' };
		await store.reconcileThread();
		await settle();
		expect(store.getSessionTier()).toBeNull();
	});

	it('is not taken over for another chat opened while the record was on its way', async () => {
		await reload();
		let release!: () => void;
		threadHold = new Promise<void>((r) => { release = r; });
		const reconciled = store.reconcileThread();
		await settle();
		store.newChat();
		release();
		await reconciled;
		await settle();
		expect(store.getSessionId()).toBeNull();
		expect(store.getSessionTier()).toBeNull();
	});

	it('is not read again once known', async () => {
		await reload();
		await store.reconcileThread();
		await settle();
		const reads = threadReads;
		thread = { id: 't1', model_tier: 'fast' };
		await store.reconcileThread();
		await settle();
		expect(store.getSessionTier()).toBe('deep');
		// The contained-state read may still come; the tier read does not.
		expect(threadReads - reads).toBeLessThanOrEqual(1);
	});
});
