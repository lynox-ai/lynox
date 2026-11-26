// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The server holds a message while the review of the last run is open (`409`, code
// `review_pending`): a new run would replace that review. The chat keeps the message waiting,
// first in the queue, shows the review, and sends the message once the review is answered or
// turns out to be gone. It reads the hold wherever a 409 can arrive, also in the busy poll.

type Store = typeof import('./chat.svelte.js');

const toasts = vi.hoisted(() => [] as unknown[][]);
vi.mock('./toast.svelte.js', () => ({ addToast: (...args: unknown[]) => { toasts.push(args); return 1; } }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type RunAnswer = 'busy' | 'held' | 'owner' | 'ok';

let store: Store;
let saved: Map<string, string>;
let runTasks: string[];
/** What each `/run` answers, in order; `ok` once the list is used up. */
let runAnswers: RunAnswer[];
let card: Array<{ file: string; status: string; diff: string }>;
let changesetStatus: number;
let reviewAnswer: { status: number; body: unknown };
/** While set, the first run's stream stays open until it resolves. */
let holdFirstRun: Promise<void> | null;

const notes = [{ file: 'notes.md', status: 'modified', diff: '-a\n+b' }];

function serve(): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/changeset/review')) return json(reviewAnswer.body, reviewAnswer.status);
		if (url.endsWith('/sessions')) {
			const body = init?.body ? JSON.parse(String(init.body)) as { threadId?: string } : {};
			return json({ sessionId: body.threadId ?? 't1' });
		}
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/run')) {
			const body = JSON.parse(String(init?.body)) as { task?: string };
			runTasks.push(String(body.task));
			const answer = runAnswers.shift() ?? 'ok';
			if (answer === 'busy') return json({ error: 'A run is already in progress for this session' }, 409);
			if (answer === 'held') return json({ error: 'The changes of the last run wait for a review', code: 'review_pending', runId: 'run-7' }, 409);
			if (answer === 'owner') return json({ error: 'This conversation still has changes waiting for the owner\'s review', code: 'review_pending_owner' }, 409);
			const enc = new TextEncoder();
			const held = runTasks.length === 1 ? holdFirstRun : null;
			return new Response(new ReadableStream<Uint8Array>({
				async start(c) { if (held) await held; c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ result: 'ok' })}\n\n`)); c.close(); },
			}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		if (url.endsWith('/changeset')) {
			if (changesetStatus !== 200) return json({ error: 'no' }, changesetStatus);
			return json({ hasChanges: card.length > 0, runId: 'run-7', files: card });
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
	vi.stubGlobal('window', { addEventListener: () => {} });
	vi.stubGlobal('document', { querySelector: () => null });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	toasts.length = 0;
	runTasks = [];
	runAnswers = [];
	card = [];
	changesetStatus = 200;
	reviewAnswer = { status: 200, body: { ok: true, accepted: 1, rolledBack: 0, notRestored: [] } };
	holdFirstRun = null;
	serve();
});
afterEach(() => { vi.unstubAllGlobals(); });

const message = (content: string): ReturnType<Store['getMessages']>[number] | undefined =>
	store.getMessages().find((m) => m.role === 'user' && m.content === content);

describe('a message the open review holds', () => {
	it('waits queued, asks no second time, and the review is shown; answering it sends the message', async () => {
		runAnswers = ['held'];
		card = notes;
		await store.sendMessage('next step');
		await settle();
		await wait(3_300); // past one busy-poll interval: a poll would have asked again
		await settle();
		expect(runTasks, 'asked once').toEqual(['next step']);
		expect(message('next step')).toMatchObject({ queued: true, failed: false });
		expect(store.getPendingChangeset(), 'the review is shown').not.toBeNull();
		expect(store.getMessages().some((m) => m.role === 'assistant' && !m.content), 'no empty answer left').toBe(false);

		await store.submitChangesetReview('accept');
		await wait(200);
		await settle();
		expect(runTasks, 'the answer sends it').toEqual(['next step', 'next step']);
	});

	it('a hold that answers a later busy poll ends the poll there', async () => {
		runAnswers = ['busy', 'held', 'ok'];
		card = notes;
		void store.sendMessage('next step');
		await settle();
		await wait(3_300); // the first poll
		await settle();
		expect(runTasks, 'positive control: the poll asked again').toEqual(['next step', 'next step']);
		await wait(3_300); // a second poll, were the loop still running
		await settle();
		expect(runTasks, 'no poll after the hold').toEqual(['next step', 'next step']);
		expect(message('next step')).toMatchObject({ queued: true, failed: false });
		expect(store.getPendingChangeset()).not.toBeNull();
	});

	it('is sent when the fetch after the hold finds no review any more', async () => {
		runAnswers = ['held', 'ok'];
		card = [];
		await store.sendMessage('next step');
		await settle();
		await wait(300);
		await settle();
		expect(store.getPendingChangeset()).toBeNull();
		expect(runTasks, 'sent again, not stuck in the queue').toEqual(['next step', 'next step']);
		expect(message('next step')?.queued).toBe(false);
	});

	it('is not sent again when the fetch after the hold fails: it is failed, for a tap', async () => {
		runAnswers = ['held', 'ok'];
		changesetStatus = 500;
		await store.sendMessage('next step');
		await settle();
		await wait(500);
		await settle();
		expect(runTasks, 'asked once, not again and again').toEqual(['next step']);
		expect(message('next step')).toMatchObject({ queued: false, failed: true });
	});

	it('held again right after a fetch that found no review: it is failed, not sent a third time', async () => {
		runAnswers = ['held', 'held', 'ok'];
		card = [];
		await store.sendMessage('next step');
		await settle();
		await wait(500);
		await settle();
		expect(runTasks, 'positive control: the empty fetch sent it once more').toHaveLength(2);
		await wait(500);
		await settle();
		expect(runTasks, 'no third send').toHaveLength(2);
		expect(message('next step')).toMatchObject({ queued: false, failed: true });
	});

	it('failed for a tap, it does not keep the message queued behind it waiting', async () => {
		let release!: () => void;
		holdFirstRun = new Promise<void>((r) => { release = r; });
		runAnswers = ['ok', 'held', 'ok'];
		changesetStatus = 500;
		void store.sendMessage('edit the notes');
		await settle();
		await store.sendMessage('first');
		await store.sendMessage('second');
		expect(message('second')?.queued, 'positive control: both wait behind the run').toBe(true);
		release();
		await settle();
		await wait(500);
		await settle();
		expect(message('first'), 'positive control: the first is failed, for a tap').toMatchObject({ queued: false, failed: true });
		expect(runTasks, 'the second is sent after it').toEqual(['edit the notes', 'first', 'second']);
		expect(message('second')?.queued).toBe(false);
	});
});

describe('a turn queued before a reload, when the session is gone', () => {
	const seed = (): void => {
		saved.set('lynox-chat', JSON.stringify({
			sessionId: 't9',
			threads: { t9: [{ role: 'user', content: 'typed before reload', queued: true, queueId: 'q1' }] },
			queues: { t9: [{ id: 'q1', task: 'typed before reload' }] },
		}));
	};

	it('a review fetch answered "not found" counts as no review, and the turn is sent', async () => {
		seed();
		changesetStatus = 404;
		await store.resumeThread('t9');
		await settle();
		await wait(200);
		await settle();
		expect(runTasks).toEqual(['typed before reload']);
	});

	it('control: a review fetch that fails otherwise keeps the turn queued, unsent', async () => {
		seed();
		changesetStatus = 500;
		await store.resumeThread('t9');
		await settle();
		await wait(200);
		await settle();
		expect(runTasks).toEqual([]);
		expect(message('typed before reload')?.queued).toBe(true);
	});
});

describe('files a rollback left', () => {
	it.each([
		['without a count, says the reason is unknown', null, 'changeset.not_restored_unknown'],
		['with a count, gives the usual reasons', 1, 'changeset.not_restored'],
	] as const)('%s', async (_name, rolledBack, key) => {
		runAnswers = ['held'];
		card = notes;
		await store.sendMessage('next step');
		await settle();
		expect(store.getPendingChangeset(), 'positive control: the review is shown').not.toBeNull();
		const { t, tf } = await import('../i18n.svelte.js');
		reviewAnswer = { status: 200, body: { ok: true, accepted: 0, rolledBack, notRestored: ['notes.md'] } };
		await store.submitChangesetReview('rollback');
		await settle();
		expect(t(key), 'positive control: the key has a text').not.toBe(key);
		expect(toasts).toContainEqual([tf(key, { files: 'notes.md' }), 'error', null]);
	});
});

describe('a rollback the server could not do', () => {
	const openReview = async (): Promise<void> => {
		runAnswers = ['held'];
		card = notes;
		await store.sendMessage('next step');
		await settle();
		expect(store.getPendingChangeset(), 'positive control: the review is shown').not.toBeNull();
	};

	it('a rollback that stopped partway names what is left until closed, shows the card again with it, and the held message keeps waiting', async () => {
		await openReview();
		const { t, tf } = await import('../i18n.svelte.js');
		reviewAnswer = { status: 500, body: { error: 'The rollback stopped partway', code: 'rollback_aborted', notRestored: ['notes.md'] } };
		await store.submitChangesetReview('rollback');
		await settle();
		expect(t('changeset.rollback_aborted'), 'positive control: the key has a text').not.toBe('changeset.rollback_aborted');
		expect(toasts).toContainEqual([tf('changeset.rollback_aborted', { files: 'notes.md' }), 'error', null]);
		expect(store.getPendingChangeset()?.map((f) => f.file), 'the card is back with what is left').toEqual(['notes.md']);
		await wait(200);
		await settle();
		expect(runTasks, 'the review is still open: the held message waits').toEqual(['next step']);
		// Answered again, the review ends and the message goes.
		reviewAnswer = { status: 200, body: { ok: true, accepted: 0, rolledBack: 1, notRestored: [] } };
		await store.submitChangesetReview('rollback');
		await wait(200);
		await settle();
		expect(runTasks).toEqual(['next step', 'next step']);
	});

	it('a rollback that stopped partway with nothing left ends the review, and the held message goes', async () => {
		await openReview();
		reviewAnswer = { status: 500, body: { error: 'The rollback stopped partway', code: 'rollback_aborted', notRestored: [] } };
		card = [];
		await store.submitChangesetReview('rollback');
		await wait(200);
		await settle();
		expect(store.getPendingChangeset()).toBeNull();
		expect(toasts.some((a) => String(a[0]).includes(': .')), 'no message with an empty list').toBe(false);
		expect(toasts, 'nothing to retry: no "stopped partway" message').toEqual([]);
		expect(runTasks).toEqual(['next step', 'next step']);
	});
});

describe('a run the owner\'s open review keeps from starting', () => {
	it('fails the message with the way on, at once, and asks no second time', async () => {
		runAnswers = ['owner'];
		const { t } = await import('../i18n.svelte.js');
		await store.sendMessage('next step');
		await settle();
		await wait(3_300); // past one busy-poll interval: a poll would have asked again
		await settle();
		expect(runTasks, 'asked once').toEqual(['next step']);
		expect(message('next step')).toMatchObject({ queued: false, failed: true });
		expect(t('changeset.review_pending_owner'), 'positive control: the key has a text').not.toBe('changeset.review_pending_owner');
		expect(store.getChatError()).toBe(t('changeset.review_pending_owner'));
		expect(store.getMessages().some((m) => m.role === 'assistant' && !m.content), 'no empty answer left').toBe(false);
	});

	it('ends a busy poll the same way when the refusal answers a later poll', async () => {
		runAnswers = ['busy', 'owner', 'ok'];
		const { t } = await import('../i18n.svelte.js');
		void store.sendMessage('next step');
		await settle();
		await wait(3_300);
		await settle();
		expect(runTasks, 'positive control: the poll asked again').toEqual(['next step', 'next step']);
		await wait(3_300);
		await settle();
		expect(runTasks, 'no poll after the refusal').toEqual(['next step', 'next step']);
		expect(message('next step')).toMatchObject({ queued: false, failed: true });
		expect(store.getChatError()).toBe(t('changeset.review_pending_owner'));
	});

	it('the messages queued behind it are sent, and refused the same way, not left waiting', async () => {
		let release: () => void = () => {};
		holdFirstRun = new Promise<void>((r) => { release = r; });
		runAnswers = ['ok', 'owner', 'owner'];
		void store.sendMessage('first');
		await settle();
		void store.sendMessage('second');
		void store.sendMessage('third');
		await settle();
		release();
		await wait(600);
		await settle();
		expect(runTasks, 'each queued message was sent').toEqual(['first', 'second', 'third']);
		expect(message('second')).toMatchObject({ queued: false, failed: true });
		expect(message('third'), 'not left waiting in the queue').toMatchObject({ queued: false, failed: true });
	});
});
