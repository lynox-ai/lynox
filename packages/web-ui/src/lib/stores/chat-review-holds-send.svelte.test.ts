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

function serve(changedFiles: Array<{ file: string; status: string; diff: string }>): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? 'GET'} ${url}`);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/run')) {
			const enc = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(enc.encode(`event: changeset_ready\ndata: ${JSON.stringify({ fileCount: changedFiles.length })}\n\n`));
					c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ result: 'edited' })}\n\n`));
					c.close();
				},
			});
			return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		if (url.endsWith('/changeset')) return json({ hasChanges: changedFiles.length > 0, files: changedFiles });
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

	it('the automatic retry on reconnect waits for the review too', async () => {
		await reviewOpen();
		store.getMessages().push({ role: 'user', content: 'sent while offline', failed: true });
		expect(listeners.online, 'positive control: the store listens for online').toBeTypeOf('function');
		listeners.online!();
		await new Promise((r) => setTimeout(r, 700)); // past the re-fire delay
		await settle();
		expect(store.getMessages().at(-1)?.failed, 'the turn stays failed').toBe(true);
		expect(runPosts(), 'nothing was sent past the open review').toBe(1);
	});

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
