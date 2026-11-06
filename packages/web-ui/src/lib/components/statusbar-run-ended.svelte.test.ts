import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The status bar reads today's cost again when a chat run ends, instead of showing the value
// from before the run until its next 30 s poll. Driven end to end: the real chat store runs a
// turn against a stubbed server, the mounted status bar reads the cost endpoint.

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
vi.mock('svelte', async () => {
	const { createRequire: req } = await import('node:module');
	const path = await import('node:path');
	return import(/* @vite-ignore */ path.join(path.dirname(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js'));
});

type Store = typeof import('../stores/chat.svelte.js');

/** A server-sent-events body the test feeds one event at a time. */
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

/** Lets read loops and the component's effects run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}
/** Longer than the status bar's coalescing delay after a run end. */
const afterDelay = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 450)); await settle(); };

const today = (): string => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let store: Store;
let stream: ReturnType<typeof sseStream>;
/** What the server has stored for today: changed by a test where the server would write the run. */
let storedCost: number;
let costReads: number;

beforeEach(async () => {
	vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
	vi.stubGlobal('navigator', { onLine: true });
	storedCost = 0;
	costReads = 0;
	stream = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.includes('/history/cost/daily')) {
			costReads++;
			return json([{ day: today(), cost_usd: storedCost, run_count: 1, user_turns: 1 }]);
		}
		if (url.endsWith('/sessions')) return json({ sessionId: 's1' });
		if (url.endsWith('/sessions/s1/run')) return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/sessions/s1/abort')) return json({ ok: true });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		// A chat opened while its run was live: by the time the client attaches, the run is over.
		if (url.endsWith('/threads/t9/messages')) {
			return json({ messages: [{ role: 'user', content: 'hello' }], activeRun: { runId: 'r9', status: 'running', lastPersistedSeq: 0 } });
		}
		if (url.endsWith('/threads/t9')) return json({ thread: null });
		if (url.includes('/runs/r9/stream')) return json({}, 404);
		if (url.endsWith('/health')) return json({ status: 'ok', version: '0.0.0', build_sha: null });
		if (url.endsWith('/providers/status')) return json({ providers: [] });
		return json({}, 404);
	}));
	store = await import('../stores/chat.svelte.js');
	store.newChat();
	target = document.createElement('div');
	document.body.appendChild(target);
	const { default: StatusBar } = await import('./StatusBar.svelte');
	component = mount(StatusBar, { target });
	await settle();
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

describe('the status bar reads today\'s cost again when a chat run ends', () => {
	it('after `done`', async () => {
		expect(costReads).toBe(1); // the read on mount
		const sent = store.sendMessage('hello');
		await settle();
		stream.send('text', { text: 'hi' });
		await afterDelay();
		expect(costReads).toBe(1); // a run in progress is no reason to read again

		storedCost = 0.42; // the server stores the run before it sends `done`
		stream.send('done', { result: 'hi' });
		stream.close();
		await sent;
		await afterDelay();
		expect(costReads).toBe(2);
		expect(target.textContent).toContain('$0.42');
	});

	it('after a stop: when the stop is confirmed, and again when the stream closes', async () => {
		const sent = store.sendMessage('hello');
		await settle();
		stream.send('text', { text: 'hi' });
		await settle();

		// The server confirms the stop while the run may still be winding down: nothing stored yet.
		await store.abortRun();
		await afterDelay();
		expect(costReads).toBe(2);

		// The stream of a stopped run closes without `done`, after the server stored the run.
		storedCost = 0.17;
		stream.close();
		await sent;
		await afterDelay();
		expect(costReads).toBe(3);
		expect(target.textContent).toContain('$0.17');
	});

	it('after an error that ends the run', async () => {
		const sent = store.sendMessage('hello');
		await settle();
		storedCost = 0.05;
		stream.send('error', { error: 'provider refused', fatal: true });
		await afterDelay();
		expect(costReads).toBe(2); // the error ends the run before the stream closes
		stream.close();
		await sent;
		await afterDelay();
		expect(target.textContent).toContain('$0.05');
	});

	it('after opening a chat whose run ended before the stream could be attached', async () => {
		storedCost = 0.09;
		await store.resumeThread('t9');
		await afterDelay();
		expect(costReads).toBe(2);
		expect(target.textContent).toContain('$0.09');
	});

	it('makes one read of signals that come close together, and none without a run end', async () => {
		await afterDelay();
		expect(costReads).toBe(1);
		window.dispatchEvent(new Event(store.RUN_ENDED_EVENT));
		window.dispatchEvent(new Event(store.RUN_ENDED_EVENT));
		window.dispatchEvent(new Event(store.RUN_ENDED_EVENT));
		await afterDelay();
		expect(costReads).toBe(2);
	});

	it('stops listening when it is removed', async () => {
		unmount(component!);
		component = undefined;
		window.dispatchEvent(new Event(store.RUN_ENDED_EVENT));
		await afterDelay();
		expect(costReads).toBe(1);
	});

	it('a read already due when it is removed does not happen', async () => {
		window.dispatchEvent(new Event(store.RUN_ENDED_EVENT));
		unmount(component!);
		component = undefined;
		await afterDelay();
		expect(costReads).toBe(1);
	});
});
