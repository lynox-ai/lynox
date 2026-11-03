// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The way out of a chat that only reads, through the chat store: the run that contains the chat
// leaves one line in the history, a refusal keeps its reason, and "Plan in a new chat" opens a
// chat with the user's own words in the input and a pointer to where it came from on its first
// run, and on no later one.

type Store = typeof import('./chat.svelte.js');

vi.mock('./toast.svelte.js', () => ({ addToast: () => 1 }));
vi.mock('./threads.svelte.js', () => ({ loadThreads: async () => {} }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;
let runBodies: Array<Record<string, unknown>>;
/** What the server says about the thread after a run. */
let containedAfterRun: boolean;
/** The events of the next run, before `done`. */
let runEvents: Array<[string, Record<string, unknown>]>;
let sessionCount: number;
/** How many of the next runs the server refuses with a 500. */
let failRuns: number;

function serve(): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/sessions')) { sessionCount++; return json({ sessionId: `t${sessionCount}` }); }
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/run')) {
			if (failRuns > 0) { failRuns--; return new Response('boom', { status: 500 }); }
			runBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			const enc = new TextEncoder();
			const events = runEvents;
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					for (const [name, data] of events) c.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
					c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ result: 'ok' })}\n\n`));
					c.close();
				},
			});
			return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		if (/\/threads\/[^/]+$/.test(url) && (init?.method ?? 'GET') === 'GET') {
			return json({ thread: { skip_extraction: containedAfterRun ? 1 : 0, contained: containedAfterRun } });
		}
		return json({ messages: [], activeRun: null });
	}));
}

const refusedWrite: Array<[string, Record<string, unknown>]> = [
	['tool_call', { name: 'http_request', input: { url: 'https://shop.myshopify.com/admin/api/2025-01/products/1.json', method: 'PUT' } }],
	['tool_result', { name: 'http_request', result: 'Not sent: …', isError: true, contained: 'contained_write' }],
];

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('window', { addEventListener: () => {} });
	vi.stubGlobal('document', { querySelector: () => null });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	runBodies = [];
	containedAfterRun = false;
	runEvents = [];
	sessionCount = 0;
	failRuns = 0;
	serve();
});
afterEach(() => { vi.unstubAllGlobals(); });

const notices = (): number => store.getMessages().filter((m) => m.containedNotice === true).length;

describe('the run that makes a chat read-only', () => {
	it('leaves one line in the history, under its answer', async () => {
		containedAfterRun = true;
		await store.sendMessage('Zeig mir Produkte mit schwachen Beschreibungen', undefined, undefined, { typed: true });
		await settle();
		expect(store.getThreadContained()).toBe(true);
		// Two ends of the run read the thread; the line is there once.
		expect(notices()).toBe(1);
		// A mark on the answer, not a message of its own: the history keeps the server's length,
		// and the answer stays last, which the follow-ups hang on.
		const msgs = store.getMessages();
		expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
		expect(msgs[1]?.containedNotice).toBe(true);
	});

	it('marks the run\'s own answer, not a compaction note that came after it', async () => {
		containedAfterRun = true;
		runEvents = [
			['text', { text: 'Zwei Produkte haben kurze Beschreibungen.' }],
			['context_compacted', { previousUsagePercent: 91 }],
		];
		await store.sendMessage('Zeig mir Produkte', undefined, undefined, { typed: true });
		await settle();
		const msgs = store.getMessages();
		const note = msgs.find((m) => m.compactionNote);
		expect(note, 'positive control: the note is in the history, after the answer').toBeDefined();
		expect(msgs.indexOf(note!)).toBeGreaterThan(msgs.findIndex((m) => m.content.includes('kurze Beschreibungen')));
		expect(note?.containedNotice).toBeUndefined();
		expect(msgs.find((m) => m.content.includes('kurze Beschreibungen'))?.containedNotice).toBe(true);
	});

	it('marks the answer of the run that made it read-only, not an earlier one', async () => {
		runEvents = [['text', { text: 'Erste Antwort.' }]];
		await store.sendMessage('Hallo', undefined, undefined, { typed: true });
		await settle();
		containedAfterRun = true;
		runEvents = [['text', { text: 'Zweite Antwort.' }]];
		await store.sendMessage('Zeig mir Produkte', undefined, undefined, { typed: true });
		await settle();
		expect(store.getMessages().map((m) => m.containedNotice === true)).toEqual([false, false, false, true]);
	});

	it('leaves no line when a later run ends in a chat that already only reads', async () => {
		containedAfterRun = true;
		await store.sendMessage('Zeig mir Produkte', undefined, undefined, { typed: true });
		await settle();
		await store.sendMessage('Und die Titel?', undefined, undefined, { typed: true });
		await settle();
		expect(store.getMessages().map((m) => m.containedNotice === true)).toEqual([false, true, false, false]);
	});

	it('leaves none when the chat stays as it was', async () => {
		await store.sendMessage('Wie spät ist es?', undefined, undefined, { typed: true });
		await settle();
		expect(store.getThreadContained()).toBe(false);
		expect(notices()).toBe(0);
	});

	it('keeps the reason of a refused store write on the call', async () => {
		containedAfterRun = true;
		runEvents = refusedWrite;
		await store.sendMessage('Verbessere die', undefined, undefined, { typed: true });
		await settle();
		const reply = store.getMessages().find((m) => m.role === 'assistant' && m.toolCalls?.length);
		expect(reply?.toolCalls?.[0]?.contained).toBe('contained_write');
	});
});

describe('"Plan in a new chat"', () => {
	async function containedChat(): Promise<void> {
		containedAfterRun = true;
		await store.sendMessage('Zeig mir Produkte mit schwachen Beschreibungen', undefined, undefined, { typed: true });
		await settle();
		// A text the app composed (a framing from another view) sits in a user turn too.
		await store.sendMessage('MARKER-framing from another view');
		await settle();
		runEvents = [
			['tool_call', { name: 'http_request', input: { url: 'https://shop.myshopify.com/admin/api/2025-01/products.json' } }],
			['tool_result', { name: 'http_request', result: '{"products":[{"title":"MARKER-store-data"}]}' }],
		];
		await store.sendMessage('Verbessere die' + String.fromCodePoint(0xe0041), undefined, undefined, { typed: true });
		await settle();
		runEvents = [];
		expect(store.getThreadContained(), 'positive control: the chat is contained').toBe(true);
		expect(JSON.stringify(store.getMessages()), 'positive control: the markers are in the old chat').toContain('MARKER-store-data');
	}

	it('opens a new chat whose input holds only what the user typed, without hidden characters', async () => {
		await containedChat();
		store.planInNewChat();
		expect(store.getSessionId()).toBeNull();
		expect(store.getMessages()).toEqual([]);
		expect(store.getThreadContained()).toBe(false);
		const prefill = store.getContainedPrefill();
		expect(prefill).toBe('Zeig mir Produkte mit schwachen Beschreibungen\n\nVerbessere die');
		expect(prefill).not.toContain('MARKER');
		expect(store.getContainedOrigin()).toEqual({ id: 't1', removedHidden: true });
		// Nothing is sent by opening it.
		expect(runBodies.length).toBe(3);
	});

	it('says nothing about hidden characters when none were taken out', async () => {
		containedAfterRun = true;
		await store.sendMessage('Verbessere die Texte', undefined, undefined, { typed: true });
		await settle();
		store.planInNewChat();
		expect(store.getContainedOrigin()).toEqual({ id: 't1', removedHidden: false });
	});

	it('points the first run at where it came from, and no later run', async () => {
		await containedChat();
		store.planInNewChat();
		containedAfterRun = false;
		await store.sendMessage(store.getContainedPrefill() ?? '', undefined, undefined, { typed: true });
		await settle();
		const first = runBodies[runBodies.length - 1]!;
		expect(first['context']).toEqual({ kind: 'contained-origin', id: 't1' });
		expect(first['task']).not.toContain('MARKER');
		expect(store.getContainedOrigin()).toBeNull();
		expect(store.getContainedPrefill()).toBeNull();
		await store.sendMessage('Und noch die Titel', undefined, undefined, { typed: true });
		await settle();
		expect(runBodies[runBodies.length - 1]!['context']).toBeUndefined();
	});

	it('does nothing in a chat that is not read-only', async () => {
		await store.sendMessage('Hallo', undefined, undefined, { typed: true });
		await settle();
		store.planInNewChat();
		expect(store.getSessionId()).toBe('t1');
		expect(store.getContainedOrigin()).toBeNull();
	});

	it('keeps where it came from when the first send fails, and gives it to the send that goes through', async () => {
		await containedChat();
		store.planInNewChat();
		containedAfterRun = false;
		const sent = runBodies.length;
		failRuns = 1;
		await store.sendMessage(store.getContainedPrefill() ?? '', undefined, undefined, { typed: true });
		await settle();
		expect(runBodies.length, 'positive control: the server took nothing').toBe(sent);
		expect(store.getMessages().some((m) => m.failed === true), 'positive control: the send failed').toBe(true);
		expect(store.getContainedOrigin()).toEqual({ id: 't1', removedHidden: true });
		// The prefill is spent once sent: nothing puts it back beside the failed turn's retry.
		expect(store.getContainedPrefill()).toBeNull();
		await store.sendMessage('Verbessere die', undefined, undefined, { typed: true });
		await settle();
		expect(runBodies[runBodies.length - 1]!['context']).toEqual({ kind: 'contained-origin', id: 't1' });
		expect(store.getContainedOrigin()).toBeNull();
	});

	it('takes a typed message sent again after a failure as typed', async () => {
		containedAfterRun = true;
		failRuns = 1;
		await store.sendMessage('Verbessere die Texte', undefined, undefined, { typed: true });
		await settle();
		const failed = store.getMessages().find((m) => m.failed === true);
		expect(failed, 'positive control: the send failed').toBeDefined();
		await store.retryFailedTurn(failed!, 'Verbessere die Texte');
		await settle();
		expect(store.getThreadContained(), 'positive control: the retry ran').toBe(true);
		const resent = store.getMessages().filter((m) => m.role === 'user' && m !== failed && m.failed !== true);
		expect(resent).toHaveLength(1);
		expect(resent[0]?.typed).toBe(true);
	});

	it('is forgotten by another new chat', async () => {
		await containedChat();
		store.planInNewChat();
		store.newChat();
		expect(store.getContainedOrigin()).toBeNull();
		expect(store.getContainedPrefill()).toBeNull();
	});
});
