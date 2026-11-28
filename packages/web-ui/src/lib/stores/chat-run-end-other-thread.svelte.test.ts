// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A run that ends after another thread was opened leaves that thread's state alone: the card of
// a question waiting there stays. So does a run whose stream dropped and whose re-attach lets go
// after the switch.

type Store = typeof import('./chat.svelte.js');

vi.mock('./toast.svelte.js', () => ({ addToast: () => 1 }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

const QUESTION = { pending: true, promptType: 'ask_user', question: 'Which list, A or B?', options: ['A', 'B'], promptId: 'p1' };

let store: Store;
let finishRun: (() => void) | null;
/** The question waiting per thread, as the server answers it. */
let pendingIn: Map<string, unknown>;
/** The transcript per thread. */
let messagesIn: Map<string, Array<{ role: string; content: string }>>;
/** While true, the run's own stream drops before its end, and the server lists it as running. */
let dropRun: boolean;
/** The re-attach to the dropped run waits for this, then cannot reach the stream. */
let holdStream: Promise<void> | null;
let streamGets: number;

function serve(): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		// A thread opened again keeps its id; a new chat gets t1.
		if (url.endsWith('/sessions')) {
			const body = init?.body ? JSON.parse(String(init.body)) as { threadId?: string } : {};
			return json({ sessionId: body.threadId ?? 't1' });
		}
		if (url.endsWith('/runs/active')) return json({ runs: dropRun ? [{ runId: 'run-a', threadId: 't1', status: 'running', lastPersistedSeq: 0 }] : [] });
		if (url.includes('/runs/run-a/stream')) {
			streamGets++;
			if (holdStream) await holdStream;
			throw new TypeError('network');
		}
		const prompt = /\/sessions\/([^/]+)\/pending-prompt$/.exec(url);
		if (prompt) return json(pendingIn.get(prompt[1] ?? '') ?? { pending: false });
		if (url.endsWith('/run')) {
			const enc = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					// The run streams until the test finishes it.
					finishRun = () => {
						if (dropRun) { c.error(new Error('dropped')); return; }
						c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ result: 'ok' })}\n\n`));
						c.close();
					};
				},
			});
			return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		const thread = /\/threads\/([^/]+)\/messages$/.exec(url);
		if (thread) return json({ messages: messagesIn.get(thread[1] ?? '') ?? [], activeRun: null });
		return json({});
	}));
}

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('window', { addEventListener: () => {} });
	vi.stubGlobal('document', { querySelector: () => null });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	finishRun = null;
	dropRun = false;
	holdStream = null;
	streamGets = 0;
	pendingIn = new Map();
	messagesIn = new Map([['t2', [{ role: 'user', content: 'plan the week' }, { role: 'assistant', content: 'Which list, A or B?' }]]]);
	serve();
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A run streams in t1; then t2 is opened, where a scheduled run's question waits. */
async function runInT1ThenOpenT2(): Promise<void> {
	void store.sendMessage('edit the notes');
	await settle();
	expect(finishRun, 'positive control: the run in t1 streams').toBeTypeOf('function');
	pendingIn.set('t2', QUESTION);
	await store.resumeThread('t2');
	await settle();
	expect(store.getPendingPrompt()?.question, 'positive control: the card shows in t2').toBe('Which list, A or B?');
}

describe('a run that ends after another thread was opened', () => {
	it('leaves the card of the question waiting there', async () => {
		await runInT1ThenOpenT2();
		finishRun!(); // t1's run ends now
		await settle();
		expect(store.getPendingPrompt()?.question, 'the card stays').toBe('Which list, A or B?');
	});

	it('whose stream dropped, and whose re-attach lets go after the switch, leaves the card there', async () => {
		dropRun = true;
		let reach!: () => void;
		holdStream = new Promise<void>((r) => { reach = r; });
		void store.sendMessage('edit the notes');
		await settle();
		finishRun!(); // t1's stream drops; the re-attach waits for the stream
		await settle();
		expect(streamGets, 'positive control: the run tried to re-attach').toBe(1);
		pendingIn.set('t2', QUESTION);
		await store.resumeThread('t2');
		await settle();
		expect(store.getPendingPrompt()?.question, 'positive control: the card shows in t2').toBe('Which list, A or B?');
		reach(); // the stream cannot be reached
		await settle();
		expect(store.getPendingPrompt()?.question, 'the card stays').toBe('Which list, A or B?');
		expect(store.getMessages().map((m) => m.content), 't2 keeps its own messages').toEqual(['plan the week', 'Which list, A or B?']);
	});
});
