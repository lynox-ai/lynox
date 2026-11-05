// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A scheduled run's question waits in this chat: every way of sending an existing message
// again stops there — the tap on a failed message, the reconnect, the Retry banner — brings the
// question's card back and says so. The sentence depends on the card: a decision card (approval,
// deep consent) has no X to cancel it, so its sentence names none; with no such card back, nothing
// is said. A NEW message is not held here (its own register row).

type Store = typeof import('./chat.svelte.js');
type I18n = typeof import('../i18n.svelte.js');

const toasts: Array<{ message: string; type: string; ms?: number | null }> = [];
vi.mock('./toast.svelte.js', () => ({
	addToast: (message: string, type: string, ms?: number | null) => { toasts.push({ message, type, ms }); return 1; },
}));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

const QUESTION = { pending: true, promptType: 'ask_user', question: 'Which list, A or B?', options: ['A', 'B'], promptId: 'p1' };
const DECISION = { pending: true, promptType: 'ask_user', question: '⚠ mail_send needs your OK', options: ['Allow', 'Deny', '\x00'], promptId: 'p2' };
const SCHEDULED = { runs: [{ runId: 'sq1', threadId: 't1', status: 'awaiting_input', lastPersistedSeq: 0, attachable: false }] };
const NOTHING = { runs: [] };

let store: Store;
let i18n: I18n;
let calls: string[];
let listeners: Record<string, () => void>;
let active: unknown;
let pending: unknown;
let holdPending: Promise<void> | null;
let holdActive: Promise<void> | null;
let activeFails: boolean;
let holdDelete: Promise<void> | null;
let threadMessages: unknown;

function serve(): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? 'GET'} ${url}`);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (init?.method === 'DELETE' && holdDelete) await holdDelete;
		if (url.endsWith('/runs/active')) {
			if (activeFails) throw new TypeError('fetch failed');
			if (holdActive) await holdActive;
			return json(active);
		}
		if (url.endsWith('/pending-prompt')) {
			if (holdPending) await holdPending;
			return json(pending);
		}
		if (url.endsWith('/run')) {
			const enc = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(enc.encode(`event: done\ndata: ${JSON.stringify({ result: 'ok' })}\n\n`));
					c.close();
				},
			});
			return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		return json(threadMessages);
	}));
}

const runPosts = (): number => calls.filter((u) => u.endsWith('/run')).length;
const KEYS = ['chat.question_waiting', 'chat.question_waiting_decision', 'chat.question_waiting_plain', 'chat.error_connection'];
const toastKeys = (): string[] => toasts.map((x) => KEYS.find((k) => i18n.t(k) === x.message) ?? x.message);
const failedOne = (text: string) => store.getMessages().filter((m) => m.content === text);

/** A chat with one finished turn, so the thread is t1; then a scheduled run's question waits there. */
async function questionWaits(card: unknown): Promise<void> {
	await store.sendMessage('first');
	await settle();
	expect(runPosts(), 'positive control: a message is sent while nothing waits').toBe(1);
	active = SCHEDULED;
	pending = card;
}

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	listeners = {};
	vi.stubGlobal('window', { addEventListener: (event: string, fn: () => void) => { listeners[event] = fn; } });
	vi.stubGlobal('document', { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	i18n = await import('../i18n.svelte.js');
	i18n.setLocale('de');
	toasts.length = 0;
	calls = [];
	active = NOTHING;
	pending = { pending: false };
	holdPending = null;
	holdActive = null;
	activeFails = false;
	holdDelete = null;
	threadMessages = { messages: [], activeRun: null };
	serve();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the tap on a failed message', () => {
	it('with a question waiting: not sent again, the card back, the question sentence', async () => {
		await questionWaits(QUESTION);
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		await store.retryFailedTurn(store.getMessages().at(-1)!, 'again');
		await settle();
		expect(runPosts()).toBe(1);
		expect(failedOne('again').map((m) => m.failed)).toEqual([true]);
		expect(store.getPendingPermission()?.question).toBe('Which list, A or B?');
		expect(toastKeys()).toEqual(['chat.question_waiting']);
		// About 200 characters: it stays long enough to read (at least 8 s).
		expect(toasts[0]!.ms).toBeGreaterThanOrEqual(8000);
	});

	it('with a decision waiting: the decision sentence, which names no X', async () => {
		await questionWaits(DECISION);
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		await store.retryFailedTurn(store.getMessages().at(-1)!, 'again');
		await settle();
		expect(runPosts()).toBe(1);
		expect(toastKeys()).toEqual(['chat.question_waiting_decision']);
	});

	it('with another kind of card (several questions): the sentence that names no X', async () => {
		await questionWaits({ pending: true, promptType: 'ask_user', promptId: 'p3', kind: 'tabs', questions: [{ question: 'One?' }, { question: 'Two?' }] });
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		await store.retryFailedTurn(store.getMessages().at(-1)!, 'again');
		await settle();
		expect(runPosts()).toBe(1);
		expect(toastKeys()).toEqual(['chat.question_waiting_plain']);
	});

	it('with the chat’s own run waiting on a decision: the sentence that names no card, so no X', async () => {
		await questionWaits(DECISION);
		active = { runs: [{ runId: 'own', threadId: 't1', status: 'awaiting_input', lastPersistedSeq: 0 }] };
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		await store.retryFailedTurn(store.getMessages().at(-1)!, 'again');
		await settle();
		expect(runPosts()).toBe(1);
		expect(toastKeys()).toEqual(['chat.question_waiting_plain']);
		expect(toasts[0]!.ms).toBeGreaterThanOrEqual(8000);
	});

	it('with a secret card waiting: the sentence that names no X', async () => {
		await questionWaits({ pending: true, promptType: 'ask_secret', promptId: 'p5', secretName: 'API_KEY', question: 'Your key?' });
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		await store.retryFailedTurn(store.getMessages().at(-1)!, 'again');
		await settle();
		expect(runPosts()).toBe(1);
		expect(toastKeys()).toEqual(['chat.question_waiting_plain']);
	});

	it('with a mail-connection card waiting: the sentence that names no X', async () => {
		await questionWaits({ pending: true, promptType: 'connect_mail', promptId: 'p6', mailConnect: { id: 'm1', displayName: 'Mail', address: 'a@b.test', preset: 'custom', type: 'personal' } });
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		await store.retryFailedTurn(store.getMessages().at(-1)!, 'again');
		await settle();
		expect(runPosts()).toBe(1);
		expect(toastKeys()).toEqual(['chat.question_waiting_plain']);
	});

	it('with a prompt whose card cannot be shown: not sent, and nothing is said', async () => {
		await questionWaits({ pending: true, promptType: 'connect_mail', promptId: 'p4' });
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		await store.retryFailedTurn(store.getMessages().at(-1)!, 'again');
		await settle();
		expect(runPosts()).toBe(1);
		expect(toasts).toEqual([]);
	});

	it('with no question card back: not sent, and nothing is said about a question', async () => {
		await questionWaits({ pending: false });
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		await store.retryFailedTurn(store.getMessages().at(-1)!, 'again');
		await settle();
		expect(runPosts()).toBe(1);
		expect(toasts).toEqual([]);
	});
});

describe('the reconnect with a failed message', () => {
	it('with a question waiting: not sent past it — what the tap said stays true', async () => {
		await questionWaits(QUESTION);
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		listeners.online!();
		// Past the 500 ms the re-send would wait, so a held message is not merely late.
		await new Promise((r) => setTimeout(r, 700));
		await settle();
		expect(runPosts()).toBe(1);
		expect(failedOne('again').map((m) => m.failed)).toEqual([true]);
		expect(toastKeys()).toEqual(['chat.question_waiting']);
	});

	it('when the server cannot be asked yet: sent again as before, with no error said', async () => {
		await questionWaits(QUESTION);
		activeFails = true;
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		listeners.online!();
		activeFails = false;
		await new Promise((r) => setTimeout(r, 700));
		await settle();
		expect(runPosts()).toBe(2);
		expect(toasts).toEqual([]);
	});

	it('with nothing waiting: sent again, as before', async () => {
		await questionWaits(QUESTION);
		active = NOTHING;
		store.getMessages().push({ role: 'user', content: 'again', failed: true });
		listeners.online!();
		// The re-send waits 500 ms for the network to settle.
		await new Promise((r) => setTimeout(r, 700));
		await settle();
		expect(runPosts()).toBe(2);
	});
});

describe('the reconnect after a turn failed offline', () => {
	it('with a question waiting: not dropped, not sent — still failed, the card back', async () => {
		await questionWaits(DECISION);
		// The transcript ends on the question: read alone, "answered", which dropped the message.
		threadMessages = { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: '⚠ mail_send needs your OK' }], activeRun: null };
		store.getMessages().push({ role: 'user', content: 'offline turn', failed: true, failedOffline: true });
		listeners.online!();
		await new Promise((r) => setTimeout(r, 700));
		await settle();
		expect(runPosts()).toBe(1);
		expect(failedOne('offline turn').map((m) => [m.failed, m.failedOffline])).toEqual([[true, true]]);
		expect(store.getPendingPermission()?.question).toBe('⚠ mail_send needs your OK');
		expect(toastKeys()).toEqual(['chat.question_waiting_decision']);
		expect(toasts[0]!.ms).toBeGreaterThanOrEqual(8000);
	});

	it('with a question waiting and the same words already in the transcript: still held', async () => {
		await questionWaits(DECISION);
		// An earlier message with the same words arrived; this one may not have. Equal text does not
		// say which, so the message stays failed rather than being cleared as answered.
		threadMessages = { messages: [
			{ role: 'user', content: '[Now: 2026-11-05T15:00:00.000Z]\n\nja' },
			{ role: 'assistant', content: '⚠ mail_send needs your OK' },
		], activeRun: null };
		store.getMessages().push({ role: 'user', content: 'ja', failed: true, failedOffline: true });
		listeners.online!();
		await new Promise((r) => setTimeout(r, 700));
		await settle();
		expect(runPosts()).toBe(1);
		expect(failedOne('ja').map((m) => [m.failed, m.failedOffline])).toEqual([[true, true]]);
	});

	it('with nothing waiting and the same transcript: cleared as answered, as before', async () => {
		await questionWaits(DECISION);
		active = NOTHING;
		threadMessages = { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: '⚠ mail_send needs your OK' }], activeRun: null };
		store.getMessages().push({ role: 'user', content: 'offline turn', failed: true, failedOffline: true });
		listeners.online!();
		await new Promise((r) => setTimeout(r, 700));
		await settle();
		expect(runPosts()).toBe(1);
		expect(store.getMessages().some((m) => m.content === 'offline turn' && m.failed === true)).toBe(false);
	});
});

describe('Retry on an interrupted run', () => {
	async function interrupted(): Promise<void> {
		threadMessages = {
			messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'half' }],
			activeRun: { runId: 'r-int', status: 'interrupted', lastPersistedSeq: 0 },
		};
		await store.reconcileThread();
		expect(store.getRunInterrupted(), 'positive control: the banner is up').toEqual({ runId: 'r-int' });
	}

	it('with a question waiting: the banner stays, nothing is sent, the question sentence', async () => {
		await questionWaits(QUESTION);
		await interrupted();
		await store.retryInterruptedRun();
		await settle();
		expect(store.getRunInterrupted()).toEqual({ runId: 'r-int' });
		expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([]);
		expect(runPosts()).toBe(1);
		expect(toastKeys()).toEqual(['chat.question_waiting']);
	});

	it('never goes into a chat opened while the server was being asked', async () => {
		await questionWaits(QUESTION);
		await interrupted();
		active = NOTHING;
		let release!: () => void;
		holdActive = new Promise((r) => { release = r; });
		const retry = store.retryInterruptedRun();
		await settle();
		store.newChat();
		release();
		await retry;
		await settle();
		expect(runPosts()).toBe(1);
	});

	it('never goes into a chat opened while the banner was being dismissed', async () => {
		await questionWaits(QUESTION);
		await interrupted();
		active = NOTHING;
		let release!: () => void;
		holdDelete = new Promise((r) => { release = r; });
		const retry = store.retryInterruptedRun();
		await settle();
		expect(calls.some((c) => c.startsWith('DELETE')), 'positive control: the dismiss is under way').toBe(true);
		store.newChat();
		release();
		await retry;
		await settle();
		expect(runPosts()).toBe(1);
	});

	it('with nothing waiting: dismissed and sent, as before', async () => {
		await questionWaits(QUESTION);
		await interrupted();
		active = NOTHING;
		await store.retryInterruptedRun();
		await settle();
		expect(store.getRunInterrupted()).toBeNull();
		expect(runPosts()).toBe(2);
	});
});

describe('a new message', () => {
	it('is not held by this change: it is sent as before', async () => {
		await questionWaits(QUESTION);
		await store.sendMessage('hello');
		await settle();
		expect(runPosts()).toBe(2);
	});
});

describe('the card of a waiting prompt', () => {
	it('is not shown in a chat opened while it was being fetched', async () => {
		await questionWaits(QUESTION);
		let release!: () => void;
		holdPending = new Promise((r) => { release = r; });
		const check = store.checkPendingPrompt();
		await settle();
		store.newChat();
		release();
		await expect(check).resolves.toBeNull();
		expect(store.getPendingPermission()).toBeNull();
	});
});

describe('the sentences, word for word (reviewed wording)', () => {
	const TEXT: Record<string, { de: string; en: string }> = {
		'chat.question_waiting': {
			de: 'In diesem Chat wartet eine Frage auf deine Antwort. Beantworte sie zuerst oder brich sie mit dem X auf der Karte ab; dann geht der Lauf ohne Antwort weiter. Deine Nachricht wurde nicht noch einmal gesendet.',
			en: 'A question in this chat is waiting for your answer. Answer it first, or cancel it with the X on the card; the run then goes on without an answer. Your message was not sent again.',
		},
		'chat.question_waiting_decision': {
			de: 'In diesem Chat wartet eine Entscheidung auf dich. Triff sie zuerst auf der Karte; deine Nachricht wurde nicht noch einmal gesendet.',
			en: 'A decision in this chat is waiting for you. Make it on the card first; your message was not sent again.',
		},
		'chat.question_waiting_plain': {
			de: 'In diesem Chat wartet eine Frage auf deine Antwort. Beantworte sie zuerst; deine Nachricht wurde nicht noch einmal gesendet.',
			en: 'A question in this chat is waiting for your answer. Answer it first; your message was not sent again.',
		},
	};
	for (const key of Object.keys(TEXT)) {
		it(key, () => {
			i18n.setLocale('de');
			expect(i18n.t(key)).toBe(TEXT[key]!.de);
			i18n.setLocale('en');
			expect(i18n.t(key)).toBe(TEXT[key]!.en);
		});
	}

	it('the key follows the card: a decision has no X, a question has it, no card has no sentence', () => {
		expect(store.questionWaitingKey('decision')).toBe('chat.question_waiting_decision');
		expect(store.questionWaitingKey('question')).toBe('chat.question_waiting');
		expect(store.questionWaitingKey('other')).toBe('chat.question_waiting_plain');
		expect(store.questionWaitingKey(null)).toBeNull();
		i18n.setLocale('de');
		expect(i18n.t('chat.question_waiting_decision')).not.toContain('X');
		expect(i18n.t('chat.question_waiting_plain')).not.toContain('X');
	});
});
