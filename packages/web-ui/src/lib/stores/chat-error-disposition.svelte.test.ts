import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Drives events through the real chat store: an engine `error` event does not
// decide that a turn is dead — the server does. The engine emits `error` both
// for a dead turn and for an incident it recovers from; marking the user's
// message failed on the event alone offers "tap to retry" on a turn that is
// still running and being billed.

type Store = typeof import('./chat.svelte.js');

/** A server-sent-events body the test feeds one event at a time. */
function sseStream(): { body: ReadableStream<Uint8Array>; send: (type: string, data: unknown, seq?: number) => void; close: () => void } {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return {
		body,
		send: (type, data, seq) => ctrl.enqueue(enc.encode(`${seq ? `id: ${seq}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
		close: () => ctrl.close(),
	};
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Lets the store's read loops consume what was enqueued. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;
let calls: string[];

beforeEach(async () => {
	// The store reads `navigator.onLine` before sending: pin it online, whatever the environment says.
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	calls = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('re-attached run: an engine error does not mark the turn failed', () => {
	it('keeps the user message standing through a non-fatal error, and adopts the server transcript at the end', async () => {
		const stream = sseStream();
		let messagesReads = 0;
		vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
			if (url.endsWith('/threads/t1')) return json({ thread: null });
			if (url.endsWith('/threads/t1/messages')) {
				messagesReads++;
				// First read: the transcript up to the live run. Later read (the
				// reconcile after the run ends): the persisted answer.
				return messagesReads === 1
					? json({ messages: [{ role: 'user', content: 'plan it' }], activeRun: { runId: 'r1', status: 'running', lastPersistedSeq: 0 } })
					: json({ messages: [{ role: 'user', content: 'plan it' }, { role: 'assistant', content: 'here is the plan' }], activeRun: null });
			}
			if (url.includes('/runs/r1/stream')) return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
			return json({}, 404);
		}));

		await store.resumeThread('t1');
		await settle();

		stream.send('text', { text: 'working on it' }, 1);
		// A non-fatal incident: the engine reports it and continues the turn.
		stream.send('error', { message: 'tool input unparsable', fatal: false }, 2);
		await settle();

		const user = store.getMessages().find((m) => m.role === 'user');
		expect(user?.failed).not.toBe(true);

		stream.send('text', { text: ' — continuing' }, 3);
		stream.send('done', { resumed: true });
		stream.close();
		await settle();

		const msgs = store.getMessages();
		expect(msgs.find((m) => m.role === 'user')?.failed).not.toBe(true);
		expect(msgs.at(-1)).toMatchObject({ role: 'assistant', content: 'here is the plan' });
		expect(messagesReads).toBe(2); // the reconcile after `done` is what settles the turn
	});
});

describe('fresh run: an engine error hands the turn to the server probe', () => {
	it('does not mark the user message failed, and asks the server when the stream ends without `done`', async () => {
		const stream = sseStream();
		vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith('/sessions')) return json({ sessionId: 't2' });
			if (url.endsWith('/sessions/t2/run')) return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
			if (url.endsWith('/runs/active')) return json({ runs: [] });
			if (url.endsWith('/threads/t2/messages')) {
				return json({ messages: [{ role: 'user', content: 'plan it' }, { role: 'assistant', content: 'the finished answer' }], activeRun: null });
			}
			return json({}, 404);
		}));

		const sent = store.sendMessage('plan it');
		await settle();
		stream.send('text', { text: 'working' }, 1);
		stream.send('error', { message: 'tool input unparsable', fatal: false }, 2);
		await settle();
		expect(store.getMessages().find((m) => m.role === 'user')?.failed).not.toBe(true);

		// The stream ends without a terminal `done`: the store must ask the server
		// rather than decide from the event it saw.
		stream.close();
		await sent;
		await settle();

		expect(calls.some((u) => u.endsWith('/runs/active'))).toBe(true);
		expect(store.getMessages().find((m) => m.role === 'user')?.failed).not.toBe(true);
	});
});
