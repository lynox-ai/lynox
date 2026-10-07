import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A turn whose start fails before the server answers (no connection, a request cut off) is
// marked failed and reported, the chat is free again, and the queue moves on. Nothing sends such
// a turn again without first asking the server whether a turn is still running.

type Store = typeof import('./chat.svelte.js');

const toasts: Array<{ message: string; type: string }> = [];
vi.mock('./toast.svelte.js', () => ({
	addToast: (message: string, type: string) => { toasts.push({ message, type }); return 1; },
}));

function sseStream(): { body: ReadableStream<Uint8Array>; send: (type: string, data: unknown) => void; close: () => void } {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return { body, send: (type, data) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)), close: () => ctrl.close() };
}
const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (s: ReturnType<typeof sseStream>): Response =>
	new Response(s.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const offline = (): never => { throw new TypeError('Failed to fetch'); };

let store: Store;
let calls: string[];
let listeners: Record<string, () => void>;

/** Every request goes to `route`; `/runs/active` and transcript reads default to "nothing running". */
function serve(route: (url: string, n: number) => Response | Promise<Response> | undefined): void {
	const seen: Record<string, number> = {};
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		const key = url.replace(/^.*\/api/, '');
		seen[key] = (seen[key] ?? 0) + 1;
		const r = await route(url, seen[key]!);
		if (r) return r;
		if (url.endsWith('/sessions')) {
			// A resume names its thread; a new chat gets t1.
			const asked = typeof init?.body === 'string' ? (JSON.parse(init.body) as { threadId?: string }).threadId : undefined;
			return json({ sessionId: asked ?? 't1' });
		}
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		return json({ messages: [], activeRun: null });
	}));
}

const runPosts = (): number => calls.filter((u) => u.endsWith('/run')).length;
const lastUser = () => [...store.getMessages()].reverse().find((m) => m.role === 'user');

/** The four things every start failure must leave behind. */
function expectFailedAndFree(text: string): void {
	const msgs = store.getMessages();
	const user = msgs.find((m) => m.role === 'user' && m.content === text);
	expect(user, 'user message kept').toBeDefined();
	expect(user!.failed, 'marked failed').toBe(true);
	expect(user!.sendUnconfirmed, 'marked unconfirmed').toBe(true);
	expect(msgs.some((m) => m.role === 'assistant' && !m.content), 'empty bubble removed').toBe(false);
	expect(store.getIsStreaming(), 'chat free again').toBe(false);
	expect(store.getChatError(), 'error shown').toBeTruthy();
}

beforeEach(async () => {
	listeners = {};
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('window', { addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; } });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	toasts.length = 0;
	calls = [];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a turn that cannot start', () => {
	it('when no session can be opened: the message is kept as failed, nothing is left running', async () => {
		serve((url) => (url.endsWith('/sessions') ? offline() : undefined));
		await expect(store.sendMessage('go')).resolves.toBeUndefined();
		expectFailedAndFree('go');
		expect(runPosts()).toBe(0);
	});

	it('when the request that starts it fails', async () => {
		serve((url) => (url.endsWith('/run') ? offline() : undefined));
		await expect(store.sendMessage('go')).resolves.toBeUndefined();
		expectFailedAndFree('go');
		expect(store.getSessionId()).toBe('t1');
	});

	it('when the session has to be re-created and that fails: the thread is kept', async () => {
		serve((url, n) => {
			if (url.endsWith('/run')) return json({ error: 'no session' }, 404);
			if (url.endsWith('/sessions') && n === 2) offline();
			return undefined;
		});
		await expect(store.sendMessage('go')).resolves.toBeUndefined();
		expectFailedAndFree('go');
		expect(store.getSessionId()).toBe('t1');
	});

	it('when the retry after a rate limit fails', async () => {
		serve((url, n) => {
			if (url.endsWith('/run')) return n === 1 ? new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } }) : offline();
			return undefined;
		});
		await expect(store.sendMessage('go')).resolves.toBeUndefined();
		expectFailedAndFree('go');
		expect(runPosts()).toBe(2);
	});

	it('when the retry after a provider error fails', async () => {
		serve((url, n) => {
			if (url.endsWith('/run')) return n === 1 ? new Response('down', { status: 503 }) : offline();
			return undefined;
		});
		await expect(store.sendMessage('go')).resolves.toBeUndefined();
		expectFailedAndFree('go');
		expect(runPosts()).toBe(2);
	}, 10_000);

	it('when a poll while the session is busy fails', async () => {
		serve((url, n) => {
			if (url.endsWith('/run')) return n === 1 ? json({ error: 'busy' }, 409) : offline();
			return undefined;
		});
		await expect(store.sendMessage('go')).resolves.toBeUndefined();
		expectFailedAndFree('go');
		expect(runPosts()).toBe(2);
	}, 10_000);
});

describe('a turn that cannot start while its list changes', () => {
	/** A turn whose request hangs until `fail()`, so the list can change while it is in flight. */
	function hangingRun(): { fail: () => void } {
		const pending: Array<(e: unknown) => void> = [];
		serve((url) => (url.endsWith('/run') ? new Promise<Response>((_, r) => { pending.push(r); }) : undefined));
		// Fails the oldest request still open, so a later one cannot take its place.
		return { fail: () => pending.shift()?.(new TypeError('Failed to fetch')) };
	}

	it('finds its own bubbles after one before them was removed', async () => {
		const run = hangingRun();
		const placeholder = store.pushPlaceholder('…');
		void store.sendMessage('go');
		await settle();
		// A turn queued behind it puts a bubble after its reply.
		void store.sendMessage('later');
		await settle();
		store.removePlaceholder(placeholder);
		run.fail();
		await settle();
		expectFailedAndFree('go');
		expect(store.getMessages().filter((m) => m.content === 'go')).toHaveLength(1);
		expect(store.getMessages().every((m) => m.role === 'user' || !m.failed)).toBe(true);
		// The queued turn starts next; settle it here so nothing of this test runs into the next.
		await wait(300);
		run.fail();
		await settle();
		expect(store.getMessages().find((m) => m.content === 'later')?.failed).toBe(true);
	});

	it('leaves another thread alone: a failure after the user moved on touches nothing there', async () => {
		const run = hangingRun();
		void store.sendMessage('go');
		await settle();
		store.newChat();
		run.fail();
		await settle();
		expect(store.getMessages()).toEqual([]);
		expect(store.getChatError()).toBeFalsy();
		expect(store.getSessionId()).toBeNull();
	});

	it('finds its own bubbles after the list was rebuilt in the same thread', async () => {
		const run = hangingRun();
		void store.sendMessage('go');
		await settle();
		store.cancelQueue();
		run.fail();
		await settle();
		expectFailedAndFree('go');
	});
});

describe('a turn that fails before claiming the stream', () => {
	it('leaves a turn that is streaming meanwhile alone', async () => {
		// A new chat: two sends both wait for a session. The first starts and streams; the second
		// cannot get one and fails without ever having claimed the stream.
		const live = sseStream();
		let openFirst!: () => void;
		let failSecond!: () => void;
		serve((url, n) => {
			if (url.endsWith('/sessions')) {
				return n === 1
					? new Promise<Response>((r) => { openFirst = () => r(json({ sessionId: 't1' })); })
					: new Promise<Response>((_, reject) => { failSecond = () => reject(new TypeError('Failed to fetch')); });
			}
			if (url.endsWith('/run')) return sse(live);
			return undefined;
		});
		void store.sendMessage('first');
		void store.sendMessage('second');
		await settle();
		openFirst();
		await settle();
		expect(store.getIsStreaming()).toBe(true);
		failSecond();
		await settle();
		expect(store.getIsStreaming()).toBe(true);
		expect(store.getMessages().find((m) => m.content === 'second')?.failed).toBe(true);
		live.close();
		await settle();
	});
});

describe('the queue behind a turn that cannot start', () => {
	it('moves on: the next queued turn is still sent', async () => {
		const first = sseStream();
		const third = sseStream();
		serve((url, n) => {
			if (url.endsWith('/run')) return n === 1 ? sse(first) : n === 2 ? offline() : sse(third);
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
		expect(runPosts()).toBe(3);
		expect(store.getIsStreaming()).toBe(true);
		third.close();
		await settle();
	});
});

describe('the queue while the connection is gone', () => {
	it('is kept, not handed a turn that would be dropped unsent', async () => {
		let failFirst!: () => void;
		serve((url, n) => {
			if (url.endsWith('/run') && n === 1) {
				return new Promise<Response>((_, reject) => { failFirst = () => {
					vi.stubGlobal('navigator', { onLine: false });
					reject(new TypeError('Failed to fetch'));
				}; });
			}
			return undefined;
		});
		void store.sendMessage('one');
		await settle();
		void store.sendMessage('two');
		await settle();
		expect(store.getQueueLength()).toBe(1);
		failFirst();
		await settle();
		await wait(300);
		expect(store.getMessages().find((m) => m.content === 'one')?.failed).toBe(true);
		expect(store.getQueueLength()).toBe(1);
		expect(store.getMessages().find((m) => m.content === 'two')?.queued).toBe(true);
		expect(runPosts()).toBe(1);
	});
});

describe('sending a failed turn again', () => {
	it('while a turn is streaming: the user is told, nothing is sent', async () => {
		serve((url) => (url.endsWith('/run') ? offline() : undefined));
		await store.sendMessage('go');
		const failed = lastUser()!;
		const live = sseStream();
		serve((url) => (url.endsWith('/run') ? sse(live) : undefined));
		void store.sendMessage('next');
		await settle();
		expect(store.getIsStreaming()).toBe(true);
		toasts.length = 0;
		calls = [];
		await expect(store.retryFailedTurn(failed, 'go')).resolves.toBeUndefined();
		expect(toasts).toEqual([expect.objectContaining({ type: 'info' })]);
		// Nothing about a turn was asked or sent (timers of other tests may still list threads).
		expect(calls.filter((u) => /\/run$|\/runs\//.test(u))).toEqual([]);
		live.close();
		await settle();
	});

	async function failOnce(): Promise<void> {
		serve((url) => (url.endsWith('/run') ? offline() : undefined));
		await store.sendMessage('go');
		toasts.length = 0;
		calls = [];
	}

	it('is not done while a turn is still running in the thread: the user is told and its stream attached', async () => {
		await failOnce();
		const running = sseStream();
		serve((url) => {
			if (url.endsWith('/runs/active')) return json({ runs: [{ runId: 'r1', threadId: 't1', status: 'running', lastPersistedSeq: 0 }] });
			if (url.includes('/runs/r1/stream')) return sse(running);
			return undefined;
		});
		await expect(store.retryFailedTurn(lastUser()!, 'go')).resolves.toBeUndefined();
		// Told right away, not once the running turn has ended.
		expect(toasts).toEqual([expect.objectContaining({ type: 'info' })]);
		await settle();
		expect(runPosts()).toBe(0);
		expect(calls.some((u) => u.includes('/runs/r1/stream'))).toBe(true);
		expect(toasts).toEqual([expect.objectContaining({ type: 'info' })]);
		running.close();
		await settle();
	});

	it('is not done when the server cannot be asked', async () => {
		await failOnce();
		serve((url) => (url.endsWith('/runs/active') ? offline() : undefined));
		await expect(store.retryFailedTurn(lastUser()!, 'go')).resolves.toBeUndefined();
		expect(runPosts()).toBe(0);
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
		expect(lastUser()!.failed).toBe(true);
	});

	it('is done when nothing is running', async () => {
		await failOnce();
		const next = sseStream();
		serve((url) => (url.endsWith('/run') ? sse(next) : undefined));
		void store.retryFailedTurn(lastUser()!, 'go');
		await settle();
		expect(calls.indexOf(calls.find((u) => u.endsWith('/runs/active'))!)).toBeLessThan(calls.findIndex((u) => u.endsWith('/run')));
		expect(runPosts()).toBe(1);
		next.close();
		await settle();
	});

	it('leaves a turn the user started while the question was out in charge', async () => {
		await failOnce();
		const fresh = sseStream();
		let answer!: () => void;
		serve((url) => {
			if (url.endsWith('/runs/active')) {
				return new Promise<Response>((r) => { answer = () => r(json({ runs: [{ runId: 'r1', threadId: 't1', status: 'running', lastPersistedSeq: 0 }] })); });
			}
			if (url.endsWith('/run')) return sse(fresh);
			return undefined;
		});
		const retry = store.retryFailedTurn(lastUser()!, 'go');
		await settle();
		void store.sendMessage('new');
		await settle();
		expect(store.getIsStreaming()).toBe(true);
		answer();
		await retry;
		await settle();
		expect(calls.some((u) => u.includes('/runs/r1/stream'))).toBe(false);
		expect(toasts).toEqual([]);
		fresh.close();
		await settle();
	});

	it('on reconnect asks first as well: a running turn is not sent again', async () => {
		await failOnce();
		const running = sseStream();
		serve((url) => {
			if (url.endsWith('/runs/active')) return json({ runs: [{ runId: 'r1', threadId: 't1', status: 'running', lastPersistedSeq: 0 }] });
			if (url.includes('/runs/r1/stream')) return sse(running);
			return undefined;
		});
		listeners['online']!();
		await settle();
		await wait(600);
		expect(calls.some((u) => u.endsWith('/runs/active'))).toBe(true);
		expect(runPosts()).toBe(0);
		running.close();
		await settle();
	});
});

describe('a turn whose start fails after the user moved on', () => {
	/** A per-test localStorage, so the thread copies the store saves are real. */
	function withStorage(): void {
		const data = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => { data.set(k, v); },
			removeItem: (k: string) => { data.delete(k); },
		});
	}
	/** A request that starts the turn hangs until `fail()`; every thread's server transcript is empty. */
	function hanging(): { fail: () => void } {
		const pending: Array<(e: unknown) => void> = [];
		serve((url) => (url.endsWith('/run') ? new Promise<Response>((_, r) => { pending.push(r); }) : undefined));
		return { fail: () => pending.shift()?.(new TypeError('Failed to fetch')) };
	}
	beforeEach(async () => {
		// The store saves on a 500 ms debounce, through whatever storage is there when it fires.
		// Let every earlier test's saves land before this test's storage exists.
		await wait(700);
		withStorage();
		vi.resetModules();
		store = await import('./chat.svelte.js');
	});

	async function leaveAndFail(savedWithTurn: boolean): Promise<void> {
		const run = hanging();
		void store.sendMessage('go');
		await settle();
		if (savedWithTurn) {
			// A save that ran in the window holds the turn and its empty reply.
			// An earlier turn with the same text sits before it, answered.
			const [sent, reply] = store.getMessages();
			const earlier = [{ role: 'user', content: 'go', createdAt: '2026-01-01T00:00:00.000Z' }, { role: 'assistant', content: 'done' }];
			localStorage.setItem('lynox-chat', JSON.stringify({ sessionId: 't1', threads: { t1: [...earlier, { ...sent }, { ...reply }] } }));
		}
		await store.resumeThread('t2');
		await settle();
		run.fail();
		await settle();
	}

	for (const savedWithTurn of [true, false]) {
		it(`keeps the text in its thread as a failed message${savedWithTurn ? ' (saved copy holds the turn)' : ' (saved copy older than the turn)'}`, async () => {
			await leaveAndFail(savedWithTurn);
			// The other thread is untouched.
			expect(store.getMessages()).toEqual([]);
			// Back in the turn's thread, whose server transcript never got the turn.
			await store.resumeThread('t1');
			await settle();
			const back = store.getMessages();
			const turns = back.filter((m) => m.content === 'go');
			expect(turns).toHaveLength(savedWithTurn ? 2 : 1);
			// The earlier turn with the same text is left as it was.
			if (savedWithTurn) expect(turns[0]!.failed).toBeFalsy();
			const msg = turns[turns.length - 1]!;
			expect(msg.failed).toBe(true);
			expect(msg.sendUnconfirmed).toBe(true);
			expect(back.some((m) => m.role === 'assistant' && !m.content)).toBe(false);
			// And it can be sent again from there.
			const next = sseStream();
			serve((url) => (url.endsWith('/run') ? sse(next) : undefined));
			calls = [];
			void store.retryFailedTurn(msg, 'go');
			await settle();
			expect(calls.some((u) => u.endsWith('/runs/active'))).toBe(true);
			expect(runPosts()).toBe(1);
			next.close();
			await settle();
		});
	}

	it('finds it, by its text and time, in a reloaded copy of its own thread', async () => {
		const run = hanging();
		void store.sendMessage('go');
		await settle();
		// A saved copy that holds the turn and its empty reply, and an older failed message, which
		// keeps the local copy on screen when the thread is resumed.
		const [sent, reply] = store.getMessages();
		const older = { role: 'user', content: 'earlier', createdAt: '2026-01-01T00:00:00.000Z', failed: true };
		localStorage.setItem('lynox-chat', JSON.stringify({ sessionId: 't1', threads: { t1: [older, { ...sent }, { ...reply }] } }));
		await store.resumeThread('t1');
		await settle();
		run.fail();
		await settle();
		expectFailedAndFree('go');
		expect(store.getMessages().filter((m) => m.content === 'go')).toHaveLength(1);
	});

	it('adds nothing when the reloaded thread shows the server\'s copy of the turn', async () => {
		const run = hanging();
		void store.sendMessage('go');
		await settle();
		// The server got the turn after all: its transcript holds it, stamped with its own time.
		serve((url) => {
			if (url.endsWith('/run')) return new Promise<Response>(() => {});
			if (url.includes('/threads/t1/messages')) {
				return json({ messages: [{ role: 'user', content: 'go', created_at: '2026-10-07T00:00:00.000Z' }, { role: 'assistant', content: 'done' }], activeRun: null });
			}
			return undefined;
		});
		await store.resumeThread('t1');
		await settle();
		run.fail();
		await settle();
		// Nor in the thread's saved copy, which is what is on screen.
		expect(localStorage.getItem('lynox-chat') ?? '').not.toContain('"failed":true');
		expect(store.getMessages().filter((m) => m.content === 'go')).toHaveLength(1);
		expect(store.getMessages().some((m) => m.failed)).toBe(false);
		expect(store.getChatError()).toBeFalsy();
	});

	it('leaves a turn streaming in the thread by now alone', async () => {
		const run = hanging();
		void store.sendMessage('go');
		await settle();
		// Reloaded from a local copy that holds the turn, so it is found and marked.
		const [sent, reply] = store.getMessages();
		const older = { role: 'user', content: 'earlier', createdAt: '2026-01-01T00:00:00.000Z', failed: true };
		localStorage.setItem('lynox-chat', JSON.stringify({ sessionId: 't1', threads: { t1: [older, { ...sent }, { ...reply }] } }));
		await store.resumeThread('t1');
		await settle();
		// Back in the thread, the user sends another turn, which streams.
		const live = sseStream();
		serve((url) => (url.endsWith('/run') ? sse(live) : undefined));
		void store.sendMessage('next');
		await settle();
		void store.sendMessage('queued');
		await settle();
		expect(store.getIsStreaming()).toBe(true);
		expect(store.getQueueLength()).toBe(1);
		run.fail();
		await settle();
		await wait(300);
		expect(store.getIsStreaming()).toBe(true);
		expect(store.getChatError()).toBeFalsy();
		expect(store.getQueueLength()).toBe(1);
		// The turn itself is still marked, in its place.
		expect(store.getMessages().find((m) => m.content === 'go')?.failed).toBe(true);
		live.close();
		await settle();
	});

	it('marks it again in a thread that was archived and brought back', async () => {
		const run = hanging();
		const threads = await import('./threads.svelte.js');
		await threads.archiveThread('t1');
		await threads.unarchiveThread('t1');
		void store.sendMessage('go');
		await settle();
		await store.resumeThread('t2');
		await settle();
		run.fail();
		await settle();
		const saved = JSON.parse(localStorage.getItem('lynox-chat') ?? '{}') as { threads?: Record<string, Array<{ content: string; failed?: boolean }>> };
		expect(saved.threads?.['t1']?.find((m) => m.content === 'go')?.failed).toBe(true);
	});

	it('does not bring back a thread deleted meanwhile', async () => {
		const run = hanging();
		void store.sendMessage('go');
		await settle();
		await store.resumeThread('t2');
		await settle();
		store.dropPersistedThread('t1');
		run.fail();
		await settle();
		const saved = JSON.parse(localStorage.getItem('lynox-chat') ?? '{}') as { threads?: Record<string, unknown> };
		expect(saved.threads?.['t1']).toBeUndefined();
	});
});
