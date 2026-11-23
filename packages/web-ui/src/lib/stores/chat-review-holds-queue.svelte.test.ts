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
/** While set, every run after the first streams until it resolves. */
let holdLaterRuns: Promise<void> | null;
let reviewStatus: number;
let changesetFails: boolean;
let saved: Map<string, string>;
/** Opening a thread again waits until its promise here resolves. */
let holdReopen: Map<string, Promise<void>>;
/** While set, the answer to a review waits until it resolves. */
let holdReview: Promise<void> | null;
/** A run the server still runs in a thread, for a thread opened again to re-attach to. */
let liveRunIn: string | null;
let newSessions: number;
/** How often the review was asked for. */
let changesetGets: number;
/** The signal the review fetch's time limit aborts; the test fires it. */
let fetchTimeout: AbortController;

const notes = [{ file: 'notes.md', status: 'modified', diff: '-a\n+b' }];

function serve(): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/changeset/review')) {
			if (holdReview) await holdReview;
			return json({ ok: reviewStatus === 200 }, reviewStatus);
		}
		if (url.endsWith('/sessions')) {
			const body = init?.body ? JSON.parse(String(init.body)) as { threadId?: string } : {};
			const held = body.threadId ? holdReopen.get(body.threadId) : undefined;
			if (held) await held;
			// A thread opened again keeps its id; new chats get t1, then t2.
			return json({ sessionId: body.threadId ?? (newSessions++ === 0 ? 't1' : 't2') });
		}
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/run')) {
			const body = JSON.parse(String(init?.body)) as { task?: string };
			runTasks.push(String(body.task));
			const held = runTasks.length === 1 ? holdFirstRun : holdLaterRuns;
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
		if (url.includes('/runs/r-live/stream')) {
			const enc = new TextEncoder();
			return new Response(new ReadableStream<Uint8Array>({
				start(c) { c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ result: 'ok' })}\n\n`)); c.close(); },
			}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		if (url.endsWith('/changeset')) {
			changesetGets++;
			if (holdChangeset) {
				const signal = init?.signal;
				await Promise.race([holdChangeset, new Promise<never>((_, reject) => {
					signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError')));
				})]);
			}
			if (changesetFails) return json({ error: 'unavailable' }, 503);
			return json({ hasChanges: changed.length > 0, runId: 'run-7', files: changed });
		}
		if (liveRunIn !== null && url.includes(`/threads/${liveRunIn}/messages`)) {
			liveRunIn = null; // re-attached once; the reconcile after it sees no live run
			return json({ messages: [{ role: 'user', content: 'earlier' }], activeRun: { runId: 'r-live', status: 'running', lastPersistedSeq: 0 } });
		}
		return json({ messages: [], activeRun: null });
	}));
}

beforeEach(async () => {
	saved = new Map();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => saved.get(k) ?? null,
		setItem: (k: string, v: string) => { saved.set(k, String(v)); },
		removeItem: (k: string) => { saved.delete(k); },
		clear: () => { saved.clear(); },
		key: (i: number) => [...saved.keys()][i] ?? null,
		get length() { return saved.size; },
	});
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
	holdLaterRuns = null;
	holdReopen = new Map();
	holdReview = null;
	liveRunIn = null;
	newSessions = 0;
	changesetGets = 0;
	fetchTimeout = new AbortController();
	vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => fetchTimeout.signal);
	reviewStatus = 200;
	changesetFails = false;
	serve();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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

	it('a refused answer whose new fetch fails keeps the queued turn, unsent', async () => {
		const release = await queueBehindRun();
		changed = notes;
		release();
		await settle();
		await wait(200);
		await settle();
		expect(store.getPendingChangeset(), 'positive control: the review is open').not.toBeNull();
		reviewStatus = 409;
		changesetFails = true;
		await store.submitChangesetReview('accept');
		await wait(200);
		await settle();
		expect(store.getPendingChangeset(), 'positive control: no review is shown now').toBeNull();
		expect(runTasks, 'nothing sent past the review the server may still hold').toEqual(['edit the notes']);
		expect(store.getMessages().find((m) => m.content === 'then this')?.queued, 'the turn keeps its place').toBe(true);
	});

	it('a re-send asked for while the end-of-run drain waits for the fetch starts no second turn, and waits behind', async () => {
		const release = await queueBehindRun();
		changed = notes; // the run announces changes, so their fetch starts
		let answer!: () => void;
		holdChangeset = new Promise<void>((r) => { answer = r; });
		holdLaterRuns = new Promise<void>(() => {}); // the next turn keeps streaming
		release();
		await settle();
		// A reconnect re-sends a failed turn while the end-of-run drain still waits for the fetch.
		store.getMessages().push({ role: 'user', content: 'sent while offline', failed: true });
		listeners.online!();
		await settle();
		expect(store.getMessages().find((m) => m.content === 'sent while offline')?.queued, 'positive control: queued for the re-send').toBe(true);
		await wait(700); // the re-send's drain was folded into the one that waits for the fetch
		changed = []; // the server answers: nothing to review
		answer();
		await settle();
		await wait(50);
		await settle();
		expect(runTasks, 'one turn started').toEqual(['edit the notes', 'then this']);
		expect(store.getMessages().find((m) => m.content === 'sent while offline')?.queued, 'the other waits behind it').toBe(true);
	});

	it('a drain still waiting from the chat left for a new one does not start a second turn there', async () => {
		const release = await queueBehindRun(); // in t1
		changed = notes;
		let answer!: () => void;
		holdChangeset = new Promise<void>((r) => { answer = r; });
		release();
		await settle(); // t1's drain is due and will wait for t1's review fetch
		store.newChat();
		changed = [];
		let releaseA!: () => void;
		holdLaterRuns = new Promise<void>((r) => { releaseA = r; });
		void store.sendMessage('A');
		await settle();
		holdLaterRuns = new Promise<void>(() => {}); // the turn after A keeps streaming
		await store.sendMessage('B');
		await store.sendMessage('C');
		expect(store.getQueueLength(), 'positive control: two turns wait in the new chat').toBe(2);
		releaseA();
		await settle();
		await wait(200); // the new chat's drain is due too and waits for the same fetch
		answer();
		await settle();
		await wait(50);
		await settle();
		expect(runTasks, 'one turn started in the new chat').toEqual(['edit the notes', 'A', 'B']);
		expect(store.getMessages().find((m) => m.content === 'C')?.queued, 'the other waits behind it').toBe(true);
	});

	it('a review fetch that never answers stops holding at its time limit, and the queued turn goes as before', async () => {
		const release = await queueBehindRun();
		changed = notes;
		holdChangeset = new Promise<void>(() => {}); // the server never answers
		release();
		await settle();
		await wait(200);
		await settle();
		expect(runTasks, 'positive control: held while the fetch runs').toEqual(['edit the notes']);
		fetchTimeout.abort(); // the time limit
		await settle();
		await wait(50);
		await settle();
		expect(runTasks, 'sent after the time limit').toEqual(['edit the notes', 'then this']);
	});

	it('after a review fetch hit its time limit, a later re-send goes', async () => {
		await store.sendMessage('first');
		await settle();
		changed = notes;
		holdChangeset = new Promise<void>(() => {});
		await store.sendMessage('edit the notes'); // its review fetch hangs
		await settle();
		fetchTimeout.abort();
		await settle();
		holdChangeset = null;
		changed = [];
		store.getMessages().push({ role: 'user', content: 'sent while offline', failed: true });
		listeners.online!();
		await settle();
		await wait(700); // past the re-send delay
		await settle();
		expect(runTasks).toEqual(['first', 'edit the notes', 'sent while offline']);
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

describe('a turn queued before a reload waits for the review the server holds', () => {
	const seed = (): void => {
		saved.set('lynox-chat', JSON.stringify({
			sessionId: 't9',
			threads: { t9: [{ role: 'user', content: 'typed before reload', queued: true, queueId: 'q1' }] },
			queues: { t9: [{ id: 'q1', task: 'typed before reload' }] },
		}));
	};

	it('the review is fetched and shown, and the restored turn stays queued, unsent', async () => {
		seed();
		changed = notes;
		await store.resumeThread('t9');
		await settle();
		await wait(200);
		await settle();
		expect(store.getPendingChangeset(), 'the review the server holds is shown').not.toBeNull();
		expect(runTasks, 'nothing sent past it').toEqual([]);
		expect(store.getMessages().find((m) => m.content === 'typed before reload')?.queued, 'the turn stays queued').toBe(true);
	});

	it('a re-send due in the thread left behind neither sends there nor stops the restored turn', async () => {
		seed();
		await store.sendMessage('first');
		await settle();
		store.getMessages().push({ role: 'user', content: 'sent while offline', failed: true });
		listeners.online!();
		await settle();
		expect(store.getMessages().find((m) => m.content === 'sent while offline')?.queued, 'positive control: the re-send is due').toBe(true);
		await store.resumeThread('t9');
		await settle();
		await wait(700); // past both delays
		await settle();
		expect(runTasks, 'the restored turn goes, once, and the re-send of the other thread does not').toEqual(['first', 'typed before reload']);
	});

	it('a drain due before the thread was left and opened again does not go past its review', async () => {
		const release = await queueBehindRun(); // in t1; a queued turn is saved with the thread
		release();
		await settle(); // the run ended: its drain is due in 100 ms
		await store.resumeThread('t9');
		// Back to the first thread; the server holds a review there, and the opening is slow.
		changed = notes;
		holdReopen.set('t1', new Promise<void>(() => {}));
		void store.resumeThread('t1');
		await settle();
		expect(store.getQueueLength(), 'positive control: the queue came back with the thread').toBe(1);
		await wait(200); // past the drain delay, before the review could be asked for
		await settle();
		expect(runTasks, 'the earlier drain does not send past the review').toEqual(['edit the notes']);
	});

	it('an answer to a review that arrives after another thread opened clears neither its review nor sends its turn', async () => {
		const release = await queueBehindRun(); // t1 leaves a review open
		changed = notes;
		release();
		await settle();
		await wait(200);
		await settle();
		expect(store.getPendingChangeset(), 'positive control: t1 shows its review').not.toBeNull();
		let answered!: () => void;
		holdReview = new Promise<void>((r) => { answered = r; });
		void store.submitChangesetReview('accept'); // the answer is on its way
		await settle();
		seed(); // t9 has a turn queued, and the server holds a review there too
		await store.resumeThread('t9');
		await settle();
		await wait(200);
		await settle();
		expect(store.getPendingChangeset(), 'positive control: t9 shows its own review').not.toBeNull();
		answered();
		await settle();
		await wait(200);
		await settle();
		expect(store.getPendingChangeset(), 't9\'s review stays shown').not.toBeNull();
		expect(runTasks, 'nothing sent past it').toEqual(['edit the notes']);
	});

	it('a refused answer that arrives after another thread opened asks nothing and sends nothing there', async () => {
		const release = await queueBehindRun();
		changed = notes;
		release();
		await settle();
		await wait(200);
		await settle();
		let answered!: () => void;
		holdReview = new Promise<void>((r) => { answered = r; });
		reviewStatus = 409;
		void store.submitChangesetReview('accept');
		await settle();
		seed();
		changed = []; // no review in t9
		holdReopen.set('t9', new Promise<void>(() => {})); // t9 has not asked for its review yet
		void store.resumeThread('t9');
		await settle();
		const asked = changesetGets;
		answered();
		await settle();
		await wait(200);
		await settle();
		expect(changesetGets, 'no review fetched for the thread it did not answer').toBe(asked);
		expect(runTasks, 'nothing sent in t9').toEqual(['edit the notes']);
	});

	it('a re-attached run that ends after another thread opened does not drain that thread\'s queue', async () => {
		liveRunIn = 't1';
		changed = notes;
		let answer!: () => void;
		holdChangeset = new Promise<void>((r) => { answer = r; }); // t1's fetch after its re-attach waits
		await store.resumeThread('t1');
		await settle();
		seed(); // t9 has a turn queued, and its opening is slow
		holdReopen.set('t9', new Promise<void>(() => {}));
		void store.resumeThread('t9');
		await settle();
		expect(store.getQueueLength(), 'positive control: t9\'s queue is back').toBe(1);
		changed = [];
		answer(); // t1's re-attach ends now
		await settle();
		await wait(200);
		await settle();
		expect(runTasks, 'nothing sent in t9 before it asked for its review').toEqual([]);
	});

	it('with no review the restored turn is sent (control)', async () => {
		seed();
		await store.resumeThread('t9');
		await settle();
		await wait(200);
		await settle();
		expect(runTasks).toEqual(['typed before reload']);
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
