// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The sends that start by themselves — a turn queued behind a running one, and the re-send of a
// failed turn after a reconnect — wait for an open changeset review as a typed send does. The
// check is made when the turn would start, not when it was queued: a review can open in between.

type Store = typeof import('./chat.svelte.js');

vi.mock('./toast.svelte.js', () => ({ addToast: () => 1 }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let store: Store;
let runTasks: string[];
let listeners: Record<string, () => void>;
let changed: Array<{ file: string; status: string; diff: string }>;
/** While set, the first run's stream stays open until it resolves. */
let holdFirstRun: Promise<void> | null;
/** While set, the changeset answer waits until it resolves. */
let holdChangeset: Promise<void> | null;

const notes = [{ file: 'notes.md', status: 'modified', diff: '-a\n+b' }];

function serve(): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/changeset/review')) return json({ ok: true });
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/run')) {
			const body = JSON.parse(String(init?.body)) as { task?: string };
			runTasks.push(String(body.task));
			const held = runTasks.length === 1 ? holdFirstRun : null;
			const enc = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				async start(c) {
					if (held) await held;
					const files = changed; // what the run changed is known when it ends
					if (files.length > 0) c.enqueue(enc.encode(`event: changeset_ready\ndata: ${JSON.stringify({ fileCount: files.length })}\n\n`));
					c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ result: 'ok' })}\n\n`));
					c.close();
				},
			});
			return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		if (url.endsWith('/changeset')) {
			if (holdChangeset) await holdChangeset;
			return json({ hasChanges: changed.length > 0, runId: 'run-7', files: changed });
		}
		return json({ messages: [], activeRun: null });
	}));
}

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	listeners = {};
	vi.stubGlobal('window', { addEventListener: (event: string, fn: () => void) => { listeners[event] = fn; } });
	vi.stubGlobal('document', { querySelector: () => null });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	runTasks = [];
	changed = [];
	holdFirstRun = null;
	holdChangeset = null;
	serve();
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A run that streams until released, with a message typed and queued behind it. */
async function queueBehindRun(): Promise<() => void> {
	let release!: () => void;
	holdFirstRun = new Promise<void>((r) => { release = r; });
	void store.sendMessage('edit the notes');
	await settle();
	await store.sendMessage('then this');
	expect(store.getMessages().find((m) => m.content === 'then this')?.queued, 'positive control: the message is queued').toBe(true);
	return release;
}

describe('a turn queued behind a run waits for the review that run left open', () => {
	it('the review the run left open holds the queued turn, which stays queued and is sent once the review is answered', async () => {
		const release = await queueBehindRun();
		changed = notes;
		release();
		await settle();
		await wait(200); // past the drain delay
		await settle();
		expect(store.getPendingChangeset(), 'positive control: the review is open').not.toBeNull();
		expect(runTasks, 'nothing sent past the review').toEqual(['edit the notes']);
		expect(store.getMessages().find((m) => m.content === 'then this')?.queued, 'the turn keeps its place').toBe(true);

		changed = [];
		await store.submitChangesetReview('accept');
		await wait(200);
		await settle();
		expect(runTasks, 'answering the review sends it').toEqual(['edit the notes', 'then this']);
	});

	it('a review whose fetch is still in flight when the run ends holds the queued turn too', async () => {
		const release = await queueBehindRun();
		changed = notes;
		let answer!: () => void;
		holdChangeset = new Promise<void>((r) => { answer = r; });
		release();
		await settle();
		await wait(200); // the drain is due while the review is still being fetched
		await settle();
		answer();
		await settle();
		await wait(50);
		await settle();
		expect(store.getPendingChangeset(), 'positive control: the review opened').not.toBeNull();
		expect(runTasks, 'nothing sent past the review').toEqual(['edit the notes']);
	});

	it('with no review the queued turn is sent after the run (control)', async () => {
		const release = await queueBehindRun();
		release();
		await settle();
		await wait(200);
		await settle();
		expect(runTasks).toEqual(['edit the notes', 'then this']);
	});
});

describe('the re-send after a reconnect waits for a review that opened before it starts', () => {
	it('a review that opens in the re-send delay holds the re-sent turn', async () => {
		store.getMessages().push({ role: 'user', content: 'sent while offline', failed: true });
		expect(listeners.online, 'positive control: the store listens for online').toBeTypeOf('function');
		listeners.online!();
		await settle();
		expect(store.getMessages().find((m) => m.content === 'sent while offline')?.queued, 'positive control: queued for the re-send').toBe(true);
		// Within the re-send delay a run leaves a review open.
		changed = notes;
		await store.sendMessage('edit the notes');
		await settle();
		expect(store.getPendingChangeset(), 'positive control: the review is open').not.toBeNull();
		await wait(700); // past the re-send delay
		await settle();
		expect(runTasks, 'nothing re-sent past the review').toEqual(['edit the notes']);
	});

	it('with no review the re-sent turn goes after the delay (control)', async () => {
		store.getMessages().push({ role: 'user', content: 'sent while offline', failed: true });
		listeners.online!();
		await settle();
		await wait(700);
		await settle();
		expect(runTasks).toEqual(['sent while offline']);
	});
});
