import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Drives real turns through the chat store, with the server saying whether the chat is contained
// once a run has ended. Every run end reads it (`runEnded`), some without the run's answer, and
// the line under the answer must survive the read that comes first.

type Store = typeof import('./chat.svelte.js');

function sseStream(): { body: ReadableStream<Uint8Array>; send: (type: string, data: unknown) => void; close: () => void } {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return {
		body,
		send: (type, data) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
		close: () => ctrl.close(),
	};
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;
/** What `/threads/t1` says now. */
let thread: Record<string, unknown>;
/** The stream of the next `/run`. */
let run: ReturnType<typeof sseStream>;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	thread = { id: 't1', skip_extraction: 1, contained: false };
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/threads/t1')) return json({ thread: { ...thread } });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		return json({}, 404);
	}));
});

afterEach(() => {
	store.newChat();
	vi.unstubAllGlobals();
});

/** Sends one turn whose run streams an answer, then `between` (an `error` event ends the stream
 *  early on the page, without the answer), then `done`. */
async function turn(between: (r: ReturnType<typeof sseStream>) => void = () => {}): Promise<void> {
	run = sseStream();
	const sent = store.sendMessage('read the orders');
	await settle();
	run.send('text', { text: 'here are the orders', agent: 'lynox' });
	await settle();
	between(run);
	await settle();
	run.send('done', { agent: 'lynox' });
	run.close();
	await sent;
	await settle();
}

const answers = (): Array<{ content: string; containedNotice?: boolean }> =>
	(store.getMessages() as Array<{ role: string; content: string; containedNotice?: boolean }>).filter((m) => m.role === 'assistant');

describe('a run that contains the chat: the line under its answer, read at the run end', () => {
	it('a plain run end puts the line under the answer (control)', async () => {
		thread.contained = true;
		await turn();
		expect(store.getThreadContained()).toBe(true);
		expect(answers().at(-1)?.containedNotice).toBe(true);
	});

	it('an error event ends the stream first, without the answer: the line still lands', async () => {
		thread.contained = true;
		await turn((r) => r.send('error', { error: 'tool failed' }));
		expect(store.getThreadContained()).toBe(true);
		expect(answers().at(-1)?.containedNotice).toBe(true);
	});

	it('a chat already contained when the run began gets no line', async () => {
		thread.contained = true;
		await turn();
		await turn();
		expect(answers().map((a) => a.containedNotice === true)).toEqual([true, false]);
	});

	it('a failed check: locked, no line, and taken back once the engine reads the record again', async () => {
		thread.contained = true;
		thread.contained_unknown = 'provisioned';
		await turn();
		expect(store.getThreadContained()).toBe(true);
		expect(store.getThreadContainedUnknown()).toBe('provisioned');
		expect(answers().at(-1)?.containedNotice).not.toBe(true);
		// The engine reads its record again: this chat never read store data.
		thread.contained = false;
		delete thread.contained_unknown;
		await store.reconcileThread();
		await settle();
		expect(store.getThreadContained()).toBe(false);
		expect(store.getThreadContainedUnknown()).toBeNull();
	});

	it('a failed check that turns out recorded: stays locked, now as a record', async () => {
		thread.contained = true;
		thread.contained_unknown = 'self-hosted';
		await turn();
		expect(store.getThreadContainedUnknown()).toBe('self-hosted');
		delete thread.contained_unknown;
		await store.reconcileThread();
		await settle();
		expect(store.getThreadContained()).toBe(true);
		expect(store.getThreadContainedUnknown()).toBeNull();
	});

	it('a recorded containment is not taken back by a later read', async () => {
		thread.contained = true;
		await turn();
		thread.contained = false;
		await store.reconcileThread();
		await settle();
		expect(store.getThreadContained()).toBe(true);
	});
});
