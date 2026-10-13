// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A deleted conversation stays deleted: the server answers 410 to opening it again. The chat says
// so, in the user's language, instead of "no connection", and nothing tries it again.

type Store = typeof import('./chat.svelte.js');

vi.mock('./toast.svelte.js', () => ({ addToast: () => 1 }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const gone = (): Response => json({ error: 'This conversation was deleted.', code: 'thread_deleted' }, 410);
function sseStream(): { body: ReadableStream<Uint8Array>; send: (type: string, data: unknown) => void; close: () => void } {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return { body, send: (type, data) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)), close: () => ctrl.close() };
}
const sse = (st: ReturnType<typeof sseStream>): Response =>
	new Response(st.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let store: Store;
let deletedText: string;
let calls: Array<{ url: string; body: unknown }>;

function serve(route: (url: string, n: number) => Response | Promise<Response> | undefined): void {
	const seen: Record<string, number> = {};
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined });
		const key = url.replace(/^.*\/api/, '');
		seen[key] = (seen[key] ?? 0) + 1;
		const r = await route(url, seen[key]!);
		if (r) return r;
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		return json({ messages: [], activeRun: null });
	}));
}
const sessionPosts = (): number => calls.filter((c) => c.url.endsWith('/sessions')).length;
const runPosts = (): number => calls.filter((c) => c.url.endsWith('/run')).length;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('window', { addEventListener: () => {} });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	deletedText = (await import('../i18n.svelte.js')).t('chat.error_thread_deleted');
	calls = [];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a conversation deleted elsewhere', () => {
	it('opening it starts a new chat and says it was deleted', async () => {
		serve((url) => (url.endsWith('/sessions') ? gone() : undefined));

		await store.resumeThread('t-gone');

		expect(store.getChatError()).toBe(deletedText);
		expect(store.getSessionId(), 'not attached to the deleted thread').toBeNull();
		expect(store.getMessages()).toEqual([]);
		expect(sessionPosts(), 'asked once, not again').toBe(1);
	});

	it('a message sent into it is kept as failed and says why', async () => {
		// The session was dropped (another tab deleted the chat), so the run answers 404 and the
		// session is opened again under the thread's id: that answers 410.
		serve((url, n) => {
			if (url.endsWith('/run')) return json({ error: 'no session' }, 404);
			if (url.endsWith('/sessions') && n >= 2) return gone();
			return undefined;
		});

		await store.sendMessage('hello');

		expect(store.getChatError()).toBe(deletedText);
		const user = store.getMessages().find((m) => m.role === 'user' && m.content === 'hello');
		expect(user?.failed, 'kept, failed').toBe(true);
		expect(store.getMessages().some((m) => m.role === 'assistant' && !m.content), 'empty bubble removed').toBe(false);
		expect(store.getIsStreaming()).toBe(false);
		const opens = calls.filter((c) => c.url.endsWith('/sessions'));
		expect(opens, 'opened, then one attempt to reopen it').toHaveLength(2);
		expect(opens[1]!.body, 'reopened under its own id').toEqual({ threadId: 't1' });
		expect(runPosts()).toBe(1);
	});

	it('the turns queued behind it are not sent into it', async () => {
		// Every one of them would get the same 410. Contrast: after a lost connection the queue
		// moves on (chat-turn-start-failures), because the next try may get through.
		const first = sseStream();
		serve((url, n) => {
			if (url.endsWith('/run')) return n === 1 ? sse(first) : json({ error: 'no session' }, 404);
			if (url.endsWith('/sessions') && n >= 2) return gone();
			return undefined;
		});
		void store.sendMessage('one');
		await settle();
		void store.sendMessage('two');
		void store.sendMessage('three');
		await settle();
		first.send('done', {});
		first.close();
		await settle();
		await wait(400);
		await settle();

		expect(store.getMessages().find((m) => m.content === 'two')?.failed).toBe(true);
		expect(store.getChatError()).toBe(deletedText);
		expect(runPosts(), '"three" was not sent').toBe(2);
		const three = store.getMessages().find((m) => m.content === 'three');
		expect(three?.queued, '"three" does not stay waiting for a send that never comes').toBeFalsy();
		expect(three?.failed).toBe(true);
		expect(store.getQueueLength()).toBe(0);
	});

	it('the deleted chat\'s saved copy is dropped when the server says it is gone', async () => {
		// A conversation the server deleted does not stay in this browser's storage.
		serve((url) => (url.endsWith('/sessions') ? gone() : undefined));
		localStorage.setItem('lynox-chat', JSON.stringify({ sessionId: null, threads: { 't-gone': [{ role: 'user', content: 'old text' }] } }));

		await store.resumeThread('t-gone');
		await new Promise((r) => setTimeout(r, 600));

		expect(localStorage.getItem('lynox-chat') ?? '').not.toContain('old text');
	});

	it('a send that learns of the deletion after the user moved on drops that chat\'s saved copy', async () => {
		// The user is in another chat by then: nothing is shown, and the deleted chat is not
		// written back to storage with the failed message in it.
		let answerRun!: (r: Response) => void;
		serve((url, n) => {
			if (url.endsWith('/run')) return new Promise<Response>((res) => { answerRun = res; });
			if (url.endsWith('/sessions') && n >= 2) return gone();
			return undefined;
		});
		void store.sendMessage('go');
		await settle();
		store.newChat();
		answerRun(json({ error: 'no session' }, 404));
		await settle();
		await wait(600);

		const saved = JSON.parse(localStorage.getItem('lynox-chat') ?? '{}') as { threads?: Record<string, unknown> };
		expect(saved.threads?.['t1'], 'no saved copy of the deleted chat').toBeUndefined();
		expect(store.getChatError()).toBeFalsy();
		expect(store.getMessages()).toEqual([]);
	});

	it('the two texts exist in German and English', async () => {
		const i18n = await import('../i18n.svelte.js');
		i18n.setLocale('de');
		const de = i18n.t('chat.error_thread_deleted');
		i18n.setLocale('en');
		const en = i18n.t('chat.error_thread_deleted');
		expect(de).toBe('Diese Unterhaltung wurde gelöscht. Starte einen neuen Chat.');
		expect(en).toBe('This conversation was deleted. Start a new chat.');
	});
});
