// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// An open changeset review holds the next send until it is answered. Whoever holds the user's
// text asks `sendBlockedByReview()` first and keeps the text when the answer is yes — clearing
// it and then calling `sendMessage`, which returns without sending, loses it.

type Store = typeof import('./chat.svelte.js');

const toasts: Array<{ message: string; type: string }> = [];
vi.mock('./toast.svelte.js', () => ({
	addToast: (message: string, type: string) => { toasts.push({ message, type }); return 1; },
}));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;
let calls: string[];
let listeners: Record<string, () => void>;
let threadMessages: unknown = { messages: [], activeRun: null };
let changed: Array<{ file: string; status: string; diff: string }> = [];
let holdActiveRuns: Promise<void> | null = null;

function serve(changedFiles: Array<{ file: string; status: string; diff: string }>): void {
	changed = changedFiles;
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? 'GET'} ${url}`);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/runs/active')) {
			if (holdActiveRuns) await holdActiveRuns;
			return json({ runs: [] });
		}
		if (url.endsWith('/run')) {
			const enc = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(enc.encode(`event: changeset_ready\ndata: ${JSON.stringify({ fileCount: changed.length })}\n\n`));
					c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ result: 'edited' })}\n\n`));
					c.close();
				},
			});
			return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		if (url.endsWith('/changeset')) return json({ hasChanges: changed.length > 0, files: changed });
		return json(threadMessages);
	}));
}

const runPosts = (): number => calls.filter((u) => u.endsWith('/run')).length;
const reviewOpen = async (): Promise<void> => {
	serve([{ file: 'notes.md', status: 'modified', diff: '-a\n+b' }]);
	await store.sendMessage('edit the notes');
	await settle();
	expect(store.getPendingChangeset(), 'positive control: the review is open').not.toBeNull();
};

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	listeners = {};
	threadMessages = { messages: [], activeRun: null };
	holdActiveRuns = null;
	vi.stubGlobal('window', { addEventListener: (event: string, fn: () => void) => { listeners[event] = fn; } });
	vi.stubGlobal('document', { querySelector: () => null });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	toasts.length = 0;
	calls = [];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('an open changeset review holds the next send', () => {
	it('with no review open, nothing is held and nothing is said', async () => {
		serve([]);
		expect(store.sendBlockedByReview()).toBe(false);
		expect(toasts).toEqual([]);
	});

	it('once a run left a review open: held, said once, and sendMessage sends nothing', async () => {
		serve([{ file: 'notes.md', status: 'modified', diff: '-a\n+b' }]);
		await store.sendMessage('edit the notes');
		await settle();
		expect(store.getPendingChangeset(), 'positive control: the review is open').not.toBeNull();
		expect(runPosts()).toBe(1);

		expect(store.sendBlockedByReview()).toBe(true);
		expect(toasts).toHaveLength(1);

		await store.sendMessage('next question');
		expect(runPosts(), 'the held message was not sent').toBe(1);
	});

	it('the tap on a failed message keeps it failed, and nothing is sent', async () => {
		await reviewOpen();
		const failed = { role: 'user' as const, content: 'lost?', failed: true };
		await store.retryFailedTurn(failed, 'lost?');
		await settle();
		expect(failed.failed, 'the message keeps its tap-to-retry').toBe(true);
		expect(runPosts()).toBe(1);
	});

	// The automatic re-send on reconnect is not the user's action: it waits silently, before
	// any probe, and leaves every mark on the turn as it was.
	for (const [branch, marks] of [
		['a plain failed turn', {}],
		['a turn that failed offline', { failedOffline: true }],
		['a turn whose start was never confirmed', { sendUnconfirmed: true }],
	] as const) {
		it(`reconnect with a review open: ${branch} waits, unprobed and unchanged`, async () => {
			await reviewOpen();
			const turn = { role: 'user' as const, content: 'sent while offline', failed: true, ...marks };
			store.getMessages().push(turn);
			const before = calls.length;
			toasts.length = 0;
			expect(listeners.online, 'positive control: the store listens for online').toBeTypeOf('function');
			listeners.online!();
			await new Promise((r) => setTimeout(r, 700)); // past the re-fire delay
			await settle();
			const probeOrSend = calls.slice(before).filter((c) => /\/runs\/active$|\/messages$|\/run$/.test(c));
			expect(probeOrSend, 'no probe, no send').toEqual([]);
			expect(store.getMessages().at(-1)).toMatchObject({ failed: true, ...marks });
			expect(toasts, 'nothing said for an action the user did not take').toEqual([]);
		});
	}

	// The two branches that ask the server before re-sending: a review can open while they wait.
	for (const [branch, marks] of [
		['an unconfirmed start', { sendUnconfirmed: true }],
		['a turn that failed offline', { failedOffline: true }],
	] as const) {
		it(`a review that opens while ${branch} is being asked about still holds the re-send`, async () => {
			serve([]);
			await store.sendMessage('first');
			await settle();
			expect(store.getPendingChangeset(), 'no review yet').toBeNull();
			store.getMessages().push({ role: 'user', content: 'held turn', failed: true, ...marks });
			let release!: () => void;
			holdActiveRuns = new Promise<void>((r) => { release = r; });
			listeners.online!();
			await settle();
			holdActiveRuns = null;
			changed = [{ file: 'notes.md', status: 'modified', diff: '-a\n+b' }];
			await store.sendMessage('edit the notes');
			await settle();
			expect(store.getPendingChangeset(), 'positive control: the review opened mid-question').not.toBeNull();
			// The server's answer, once released: nothing live, the thread ends on the user turn.
			threadMessages = { messages: [{ role: 'user', content: 'held turn' }], activeRun: null };
			const posts = runPosts();
			release();
			await new Promise((r) => setTimeout(r, 700));
			await settle();
			expect(runPosts(), 'nothing sent past the review').toBe(posts);
			// Every mark stays, so the next re-send asks the server again.
			expect(store.getMessages().find((m) => m.content === 'held turn')).toMatchObject({ failed: true, ...marks });
		});
	}

	it('Retry on an interrupted run keeps the banner, and nothing is sent', async () => {
		await reviewOpen();
		threadMessages = {
			messages: [{ role: 'user', content: 'edit the notes' }, { role: 'assistant', content: 'edited' }],
			activeRun: { runId: 'r-int', status: 'interrupted', lastPersistedSeq: 0 },
		};
		await store.reconcileThread();
		expect(store.getRunInterrupted(), 'positive control: the banner is up').toEqual({ runId: 'r-int' });
		await store.retryInterruptedRun();
		await settle();
		expect(store.getRunInterrupted(), 'the banner and its Retry stay').toEqual({ runId: 'r-int' });
		expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
		expect(runPosts()).toBe(1);
	});
});
