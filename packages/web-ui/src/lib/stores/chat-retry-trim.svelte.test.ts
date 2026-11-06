import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Drives events through the real chat store: when the engine retries a provider call, what the
// failed call streamed is taken back out of the message, and what earlier calls of the same turn
// streamed stays. Without it the answer shows twice (the failed call's text, then the retry's).

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

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	store = await import('./chat.svelte.js');
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function startRun(): Promise<{ stream: ReturnType<typeof sseStream>; send: (type: string, data: unknown) => Promise<void> }> {
	const stream = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 'tr' });
		if (url.endsWith('/sessions/tr/run')) return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/tr/messages')) return json({ messages: [], activeRun: null });
		return json({}, 404);
	}));
	void store.sendMessage('find the orders');
	await settle();
	return { stream, send: async (type, data) => { stream.send(type, data); await settle(); } };
}

const reply = (): ReturnType<Store['getMessages']>[number] | undefined =>
	store.getMessages().filter((m) => m.role === 'assistant').at(-1);

const retry = { attempt: 1, maxAttempts: 4, delayMs: 1, reason: 'overloaded_error: Overloaded' };

describe('a provider call the engine retries', () => {
	it('takes the failed call\'s text back out: only the retry\'s answer stays', async () => {
		const { send } = await startRun();
		await send('text', { text: 'full answer' });
		await send('retry', retry);
		expect(store.getRetryStatus()).toMatchObject({ attempt: 1, maxAttempts: 4 });
		await send('text', { text: 'recovered' });
		const msg = reply();
		expect(msg?.content).toBe('recovered');
		expect(msg?.blocks).toEqual([{ type: 'text', text: 'recovered' }]);
	});

	it('keeps an earlier call\'s text and tool chip, and takes out the failed call\'s tool chip', async () => {
		const { send } = await startRun();
		// The first call: text and a tool call, then its turn_end; the tool runs.
		await send('text', { text: 'Looking it up.' });
		await send('tool_call', { name: 'lookup_orders', input: {} });
		await send('turn_end', { stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
		await send('tool_result', { name: 'lookup_orders', result: '3 orders' });
		// The second call streams a tool call, then fails and is retried.
		await send('tool_call', { name: 'send_mail', input: { to: 'x' } });
		await send('retry', retry);
		await send('text', { text: 'Found 3 orders.' });
		const msg = reply();
		expect(msg?.toolCalls?.map((c) => c.name)).toEqual(['lookup_orders']);
		expect(msg?.toolCalls?.[0]?.status).toBe('done');
		expect(msg?.blocks?.map((b) => b.type)).toEqual(['text', 'tool_call', 'text']);
		expect(msg?.content).toBe('Looking it up.\n\nFound 3 orders.');
	});

	it('a call that fails before it streams anything takes out nothing of the call before it', async () => {
		const { send } = await startRun();
		await send('text', { text: 'Looking it up.' });
		await send('tool_call', { name: 'lookup_orders', input: {} });
		await send('turn_end', { stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
		await send('tool_result', { name: 'lookup_orders', result: '3 orders' });
		await send('retry', retry);
		await send('text', { text: 'Found 3 orders.' });
		const msg = reply();
		expect(msg?.toolCalls?.map((c) => c.name)).toEqual(['lookup_orders']);
		expect(msg?.content).toBe('Looking it up.\n\nFound 3 orders.');
	});

	it('a second retry of the same call takes out only that attempt', async () => {
		const { send } = await startRun();
		await send('text', { text: 'first try' });
		await send('retry', retry);
		await send('text', { text: 'second try' });
		await send('retry', { ...retry, attempt: 2 });
		await send('text', { text: 'answer' });
		expect(reply()?.content).toBe('answer');
	});
});
