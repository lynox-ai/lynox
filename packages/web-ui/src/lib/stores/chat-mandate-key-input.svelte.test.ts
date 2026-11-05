// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ux U-150: the server refuses a mandate's helper's
// input that looks like a key (422 `mandate_key_input`) and keeps nothing of it. The page keeps
// nothing of it either: the message bubble goes, so it is neither stored in this browser nor sent
// again by a retry; the text goes back into the message field, in memory, so a false alarm costs no
// retyping; a refused answer leaves its question open and its card comes back.

type Store = typeof import('./chat.svelte.js');

vi.mock('./toast.svelte.js', () => ({ addToast: () => 1 }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refused = (): Response => json({ error: 'Your input was not sent …', code: 'mandate_key_input' }, 422);
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

// Not key-shaped to the page's own check (no vendor prefix): it reaches the server. Joined at run
// time: a key-shaped literal is what the commit-time secret scan looks for, and this repo is public.
const KEY = ['Xq7Lm2Pz9R', 't4Vb8Nc3Kd', '6Wf1Hy5Gs0Ju'].join('');
const TYPED = `Der Token lautet ${KEY}`;

let store: Store;
let text: { left: string; returned: string };
let calls: string[];

function serve(route: (url: string) => Response | undefined): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		calls.push(url);
		const r = route(url);
		if (r) return r;
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		return json({ messages: [], activeRun: null });
	}));
}

/** This browser's saved copy, as a plain map: the node test project has no storage of its own. */
let saved: Map<string, string>;

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
	vi.resetModules();
	store = await import('./chat.svelte.js');
	const { t } = await import('../i18n.svelte.js');
	text = { left: t('chat.mandate_key_input'), returned: t('chat.mandate_key_input_returned') };
	calls = [];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a helper\'s message refused as carrying a key', () => {
	it('leaves no bubble, puts the text back into the message field, and says the returned sentence', async () => {
		serve((url) => (url.endsWith('/run') ? refused() : undefined));
		const drafted: string[] = [];
		store.registerComposerDraft((t) => { drafted.push(t); return true; });
		const resets: number[] = [];
		store.registerKeyRefusalReset(() => { resets.push(1); });

		await store.sendMessage(TYPED);
		await settle();

		expect(calls.filter((c) => c.endsWith('/run')).length, 'sent once, not again').toBe(1);
		expect(JSON.stringify(store.getMessages()), 'no bubble holds it').not.toContain(KEY);
		expect(store.getMessages().some((m) => m.failed === true), 'no failed bubble a retry would send').toBe(false);
		expect(drafted).toEqual([TYPED]);
		expect(store.getChatError()).toBe(text.returned);
		expect(resets.length).toBe(1);
		expect(JSON.stringify([...saved.values()]), 'nothing saved in this browser holds it').not.toContain(KEY);
	});

	it('a message that waited in the queue was saved; the refusal writes the saved copy over', async () => {
		// The first message's run is still going, so the second waits in the queue, and a queued
		// message is saved at once (so a reload keeps it) — with its text.
		let finishFirst: (r: Response) => void = () => {};
		let runs = 0;
		serve((url) => undefined);
		const plain = globalThis.fetch as unknown as (input: string | URL) => Promise<Response>;
		vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith('/run')) {
				calls.push(url);
				runs++;
				return runs === 1 ? new Promise<Response>((r) => { finishFirst = r; }) : refused();
			}
			return plain(input);
		}));
		store.registerComposerDraft(() => true);

		const first = store.sendMessage('Verbinde bitte unseren Shop.');
		await settle();
		await store.sendMessage(TYPED);
		expect(JSON.stringify([...saved.values()]), 'control: the queued message was saved').toContain(KEY);
		// The first run ends with an empty stream; the queue's next message goes out after it.
		finishFirst(new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
		await first;
		await new Promise((r) => setTimeout(r, 250));
		await settle();

		expect(runs, 'the queued message was sent').toBe(2);
		expect(JSON.stringify(store.getMessages())).not.toContain(KEY);
		expect(JSON.stringify([...saved.values()]), 'nothing saved in this browser holds it').not.toContain(KEY);
	});

	it('says the other sentence when the field could not take the text back', async () => {
		serve((url) => (url.endsWith('/run') ? refused() : undefined));
		store.registerComposerDraft(() => false);

		await store.sendMessage(TYPED);
		await settle();

		expect(JSON.stringify(store.getMessages())).not.toContain(KEY);
		expect(store.getChatError()).toBe(text.left);
	});

	it('control: another 422 is an ordinary failed send', async () => {
		serve((url) => (url.endsWith('/run') ? json({ error: 'nope', code: 'other' }, 422) : undefined));
		store.registerComposerDraft(() => true);

		await store.sendMessage(TYPED);
		await settle();

		expect(store.getMessages().some((m) => m.role === 'user' && m.failed === true)).toBe(true);
		expect(store.getChatError()).not.toBe(text.returned);
	});
});

describe('a helper\'s answer refused as carrying a key', () => {
	it('brings the question back, puts the answer back into the message field, and says the returned sentence', async () => {
		let pendingAsked = 0;
		serve((url) => {
			if (url.endsWith('/reply')) return refused();
			if (url.endsWith('/pending-prompt')) {
				pendingAsked++;
				return json({ pending: true, promptType: 'ask_user', promptId: 'p-1', question: 'Wie lautet der Token?', timeoutMs: 86_400_000 });
			}
			return undefined;
		});
		// A session with an open question.
		await store.resumeThread('t1');
		await settle();
		await store.checkPendingPrompt();
		expect(store.getPendingPermission()?.promptId).toBe('p-1');
		const drafted: string[] = [];
		store.registerComposerDraft((t) => { drafted.push(t); return true; });
		const resets: number[] = [];
		store.registerKeyRefusalReset(() => { resets.push(1); });
		const askedBefore = pendingAsked;

		await store.replyPermission(KEY);
		await settle();

		expect(pendingAsked, 'the open question was fetched again').toBeGreaterThan(askedBefore);
		expect(store.getPendingPermission()?.promptId, 'its card is back').toBe('p-1');
		expect(drafted).toEqual([KEY]);
		expect(resets.length).toBe(1);
		expect(store.getChatError()).toBe(text.returned);
	});
});
