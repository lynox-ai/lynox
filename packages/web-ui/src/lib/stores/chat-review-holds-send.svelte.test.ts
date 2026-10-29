// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// An open changeset review holds the next send until it is answered. Whoever holds the user's
// text asks `sendBlockedByReview()` first and keeps the text when the answer is yes — clearing
// it and then calling `sendMessage`, which returns without sending, loses it.

type Store = typeof import('./chat.svelte.js');

const toasts: Array<{ message: string; type: string; durationMs?: number | null }> = [];
vi.mock('./toast.svelte.js', () => ({
	addToast: (message: string, type: string, durationMs?: number | null) => { toasts.push({ message, type, ...(durationMs === null ? { durationMs } : {}) }); return 1; },
}));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;
let calls: string[];
let reviewBodies: unknown[];
let runBodies: Array<Record<string, unknown>>;
let reviewStatus: number | 'network' = 200;
/** The files an applied rollback answers it left as they are. */
let reviewNotRestored: string[] | undefined;
let servedRunId = 'run-7';
let listeners: Record<string, () => void>;
let threadMessages: unknown = { messages: [], activeRun: null };
let changed: Array<{ file: string; status: string; diff: string }> = [];
let holdActiveRuns: Promise<void> | null = null;

function serve(changedFiles: Array<{ file: string; status: string; diff: string }>): void {
	changed = changedFiles;
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? 'GET'} ${url}`);
		if (url.endsWith('/changeset/review')) {
			reviewBodies.push(JSON.parse(String(init?.body)));
			if (reviewStatus === 'network') throw new TypeError('Failed to fetch');
			return json({ ok: reviewStatus === 200, ...(reviewNotRestored !== undefined ? { notRestored: reviewNotRestored } : {}) }, reviewStatus);
		}
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/runs/active')) {
			if (holdActiveRuns) await holdActiveRuns;
			return json({ runs: [] });
		}
		if (url.endsWith('/run')) {
			runBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
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
		if (url.endsWith('/changeset')) return json({ hasChanges: changed.length > 0, runId: servedRunId, files: changed });
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
	reviewBodies = [];
	runBodies = [];
	reviewStatus = 200;
	reviewNotRestored = undefined;
	servedRunId = 'run-7';
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
		toasts.length = 0;
		await store.retryFailedTurn(failed, 'lost?');
		await settle();
		expect(failed.failed, 'the message keeps its tap-to-retry').toBe(true);
		expect(toasts, 'the user tapped, so the review is named').toHaveLength(1);
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
			toasts.length = 0;
			release();
			await new Promise((r) => setTimeout(r, 700));
			await settle();
			expect(runPosts(), 'nothing sent past the review').toBe(posts);
			expect(toasts, 'nothing said for an action the user did not take').toEqual([]);
			// Every mark stays, so the next re-send asks the server again.
			expect(store.getMessages().find((m) => m.content === 'held turn')).toMatchObject({ failed: true, ...marks });
		});
	}

	it('with no review open, a turn that failed offline is re-sent after the probe and loses its offline mark', async () => {
		serve([]);
		await store.sendMessage('first');
		await settle();
		store.getMessages().push({ role: 'user', content: 'offline turn', failed: true, failedOffline: true });
		threadMessages = { messages: [{ role: 'user', content: 'offline turn' }], activeRun: null };
		const posts = runPosts();
		listeners.online!();
		await new Promise((r) => setTimeout(r, 700));
		await settle();
		expect(runPosts(), 'positive control: the probe path does re-send').toBe(posts + 1);
		expect(store.getMessages().find((m) => m.content === 'offline turn')?.failedOffline).toBe(false);
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

	// The server refuses an answer that does not name the run whose changes it showed: a tab
	// can still show one run's review after another tab ran again.
	for (const [action, files, sent] of [
		['rollback', undefined, { action: 'rollback', runId: 'run-7' }],
		['partial', ['notes.md'], { action: 'partial', runId: 'run-7', rolledBackFiles: ['notes.md'] }],
	] as const) {
		it(`the ${action} answer names the run whose review was shown`, async () => {
			await reviewOpen();
			await store.submitChangesetReview(action, files ? [...files] : undefined);
			expect(reviewBodies).toEqual([sent]);
			expect(store.getPendingChangeset(), 'an applied answer closes the review').toBeNull();
			expect(toasts).toEqual([]);
		});
	}

	// A rollback that left files as they are (replaced or linked since the review) says which:
	// the review promised the original back.
	it('a rollback that could not restore a file names it, until the person closes the message', async () => {
		const { tf } = await import('../i18n.svelte.js');
		await reviewOpen();
		reviewNotRestored = ['notes.md', 'b.txt'];
		await store.submitChangesetReview('rollback');
		expect(toasts).toEqual([{ message: tf('changeset.not_restored', { files: 'notes.md, b.txt' }), type: 'error', durationMs: null }]);
		expect(store.getPendingChangeset()).toBeNull();
	});

	it('a rollback that left more than five files names five and counts the rest', async () => {
		const { tf } = await import('../i18n.svelte.js');
		await reviewOpen();
		reviewNotRestored = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
		await store.submitChangesetReview('rollback');
		const files = tf('changeset.not_restored_more', { files: 'a, b, c, d, e', n: '2' });
		expect(files, 'precondition: the count is filled in').toMatch(/a, b, c, d, e (and|und) 2/);
		expect(toasts.map((x) => x.message)).toEqual([tf('changeset.not_restored', { files })]);
	});

	it('a rollback that restored everything says nothing (control)', async () => {
		await reviewOpen();
		reviewNotRestored = [];
		await store.submitChangesetReview('rollback');
		expect(toasts).toEqual([]);
	});

	// A refused answer did nothing. Closing the review without a word would read as done.
	it('an answer to an earlier run\'s review says so, shows what is pending now, and answers that', async () => {
		const { t } = await import('../i18n.svelte.js');
		await reviewOpen();
		reviewStatus = 409;
		changed = [{ file: 'later.md', status: 'modified', diff: '-x\n+y' }];
		servedRunId = 'run-8';
		toasts.length = 0;
		await store.submitChangesetReview('rollback');
		expect(toasts.map((x) => x.message), 'the user is told why').toEqual([t('changeset.review_refused')]);
		expect(store.getPendingChangeset(), 'the current review is shown').toEqual(changed);
		reviewStatus = 200;
		await store.submitChangesetReview('accept');
		expect(reviewBodies.at(-1), 'the next answer names the run now shown').toEqual({ action: 'accept', runId: 'run-8' });
	});

	it('another refusal is not blamed on an earlier run', async () => {
		const { t } = await import('../i18n.svelte.js');
		await reviewOpen();
		reviewStatus = 400;
		changed = [];
		toasts.length = 0;
		await store.submitChangesetReview('rollback');
		expect(toasts.map((x) => x.message)).toEqual([t('changeset.review_failed')]);
		expect(store.getPendingChangeset(), 'nothing is pending any more').toBeNull();
	});

	it('an answer that may not have arrived keeps the review open', async () => {
		const { t } = await import('../i18n.svelte.js');
		await reviewOpen();
		reviewStatus = 'network';
		toasts.length = 0;
		await store.submitChangesetReview('rollback');
		expect(store.getPendingChangeset(), 'the user can answer again').not.toBeNull();
		expect(toasts.map((x) => x.message), 'the user is told it may not have arrived').toEqual([t('changeset.review_unsent')]);
	});
});

// The run is told that this client shows its changes for review afterwards: only then does the
// server let the run's file writes skip the checks before them, with this review in their place.
describe('a run started here says that this client shows its review', () => {
	it('the run request says so, and the review it announces is fetched and shown', async () => {
		serve([{ file: 'notes.md', status: 'modified', diff: '-a\n+b' }]);
		await store.sendMessage('edit the notes');
		await settle();
		expect(runBodies).toHaveLength(1);
		expect(runBodies[0]!['shows_changeset_review']).toBe(true);
		expect(store.getPendingChangeset(), 'and it does show it').not.toBeNull();
	});
});
