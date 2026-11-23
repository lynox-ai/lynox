import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// After a reload the chat holds its id (kept in this browser) and reads its transcript back; no
// session is opened. The tier that shows the model row and picker comes from the thread's record:
// the tier it runs on (`run_tier`), not the pick as asked (`model_tier`).

type Store = typeof import('./chat.svelte.js');

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;
/** What `/threads/t1` says. */
let thread: Record<string, unknown> | null;
/** Holds every `/threads/t1` read until it settles, when set; `bodyHold` holds the answer's body. */
let threadHold: Promise<void> | null;
let bodyHold: Promise<void> | null;
let threadReads = 0;
/** What the server says to a model change: the session is gone (404) until it is opened again. */
let sessionGone: boolean;
let reopenOk: boolean;
let calls: string[];

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
	thread = { id: 't1', model_tier: 'deep', run_tier: 'deep', skip_extraction: 0 };
	sessionGone = false;
	reopenOk = true;
	calls = [];
	threadHold = null;
	bodyHold = null;
	threadReads = 0;
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? 'GET'} ${url.replace(/^.*\/api/, '')} ${typeof init?.body === 'string' ? init.body : ''}`.trim());
		if (url.endsWith('/threads/t1')) {
			threadReads++;
			if (threadHold) await threadHold;
			const said = thread === null ? { thread: null, threadMissing: true } : { thread: { ...thread } };
			if (!bodyHold) return json(said);
			const body = bodyHold;
			// A response whose body arrives only once `body` settles.
			return { ok: true, status: 200, json: async () => { await body; return said; } } as unknown as Response;
		}
		if (url.endsWith('/sessions/t1/model')) return sessionGone ? json({ error: 'Session not found' }, 404) : json({ model: 'fast', modelId: 'model-fast' });
		if (url.endsWith('/sessions') && init?.method === 'POST') {
			if (!reopenOk) return json({ error: 'x' }, 500);
			sessionGone = false;
			return json({ sessionId: 't1', model: 'balanced' }, 201);
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

	it('is the tier the chat runs on, not the pick as asked, when today\'s ceiling holds it lower', async () => {
		thread = { id: 't1', model_tier: 'deep', run_tier: 'balanced' };
		await reload();
		await store.reconcileThread();
		await settle();
		expect(store.getSessionTier()).toBe('balanced');
	});

	it('stays unknown for a chat whose record is gone or carries no tier', async () => {
		thread = null;
		await reload();
		await store.reconcileThread();
		await settle();
		expect(store.getSessionTier()).toBeNull();
		thread = { id: 't1', model_tier: 'deep', run_tier: '' };
		await store.reconcileThread();
		await settle();
		expect(store.getSessionTier()).toBeNull();
	});

	it.each([['the record', 'head'], ['its body', 'body']] as const)('is not taken over for another chat opened while %s was on its way', async (_what, where) => {
		await reload();
		let release!: () => void;
		const hold = new Promise<void>((r) => { release = r; });
		if (where === 'head') threadHold = hold; else bodyHold = hold;
		const reconciled = store.reconcileThread();
		await settle();
		store.newChat();
		release();
		await reconciled;
		await settle();
		expect(store.getSessionId()).toBeNull();
		expect(store.getSessionTier()).toBeNull();
	});

	it('gives way to a tier the user picked while the record was on its way', async () => {
		await reload();
		let release!: () => void;
		bodyHold = new Promise<void>((r) => { release = r; });
		const reconciled = store.reconcileThread();
		await settle();
		expect(await store.repickSessionModel('fast')).toEqual({ ok: true, model: 'fast' });
		release();
		await reconciled;
		await settle();
		expect(store.getSessionTier()).toBe('fast');
	});

	it('is not read again once known', async () => {
		await reload();
		await store.reconcileThread();
		await settle();
		const reads = threadReads;
		thread = { id: 't1', model_tier: 'fast', run_tier: 'fast' };
		await store.reconcileThread();
		await settle();
		expect(store.getSessionTier()).toBe('deep');
		// The contained-state read may still come; the tier read does not.
		expect(threadReads - reads).toBeLessThanOrEqual(1);
	});
});

describe('changing the model of a chat whose server session is gone', () => {
	it('opens the session for this chat again and makes the change', async () => {
		await reload();
		await store.reconcileThread();
		await settle();
		sessionGone = true;
		calls = [];
		expect(await store.repickSessionModel('fast')).toEqual({ ok: true, model: 'fast' });
		expect(store.getSessionTier()).toBe('fast');
		expect(calls).toEqual([
			'PATCH /sessions/t1/model {"tier":"fast"}',
			'POST /sessions {"threadId":"t1"}',
			'PATCH /sessions/t1/model {"tier":"fast"}',
		]);
	});

	it('reports the change as failed when the session cannot be opened again', async () => {
		await reload();
		await store.reconcileThread();
		await settle();
		sessionGone = true;
		reopenOk = false;
		expect(await store.repickSessionModel('fast')).toEqual({ ok: false, reason: 'error' });
		expect(store.getSessionTier()).toBe('deep');
	});

	it('leaves the chat open now alone when the change came back for another one', async () => {
		await reload();
		await store.reconcileThread();
		await settle();
		const picked = store.repickSessionModel('fast');
		store.newChat();
		expect(await picked).toEqual({ ok: true, model: 'fast' });
		expect(store.getSessionTier()).toBeNull();
	});
});
