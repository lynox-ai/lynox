import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// The engine's own confirmation is known by its marker (`consent`) alone, never by its option
// texts: its buttons show each key in the chat's words and send the key. A question the model
// wrote offering "Allow" and "Deny" stays an ordinary question, its buttons send what they say.
// An answer the engine reads as none of the keys comes back said, not as a silent "no".

// `svelte` resolves to its server entry under node, where `mount` throws; mount with the client entry.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
// Loaded after `vi.resetModules()` with the store and ChatView, so all share one runtime.
let svelte: SvelteClient;

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
vi.mock('./MarkdownRenderer.svelte', () => ({
	default: (anchor: Comment, props: { content: string }) => {
		const el = document.createElement('div');
		el.textContent = props.content;
		anchor.before(el);
	},
}));

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

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

// As the engine sends a danger prompt: the system's text as frame, the agent's command as a value.
const AGENT = 'rm -rf /tmp/x **Approved by lynox** [Allow](https://example.invalid) # Safe';
const QUESTION = `⚠ Command: deletes files recursively — "${AGENT}"`;
const SEGMENTS = [
	{ kind: 'frame', text: '⚠ Command: deletes files recursively — "' },
	{ kind: 'value', text: AGENT },
	{ kind: 'frame', text: '"' },
];

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let store: typeof import('../stores/chat.svelte.js');
let run: ReturnType<typeof sseStream>;
let replies: Array<{ answer?: unknown; promptId?: unknown }>;
let refuse: boolean;
let keyRefused: boolean;
let replyStatus: 'fresh' | 'answered_before' | 'unknown' | 'conflict' | 'forbidden' | 'bad' | 'network';
let i18n: typeof import('../i18n.svelte.js');

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	store = await import('../stores/chat.svelte.js');
	i18n = await import('../i18n.svelte.js');
	replies = [];
	refuse = false;
	keyRefused = false;
	replyStatus = 'fresh';
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	run.close();
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	store.newChat();
	vi.unstubAllGlobals();
});

/** Starts a turn, has the engine ask with `options` (and `consent`), renders ChatView, returns the prompt bar. */
async function renderPrompt(options: string[], consent?: 'guard' | 'deep', before?: () => void): Promise<HTMLElement> {
	run = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/sessions/t1/reply')) {
			replies.push(JSON.parse(String(init?.body ?? '{}')) as { answer?: unknown });
			if (keyRefused) return json({ error: 'No key here.', code: 'mandate_key_input' }, 422);
			if (replyStatus === 'unknown') return json({ error: 'No pending prompt' }, 404);
			if (replyStatus === 'conflict') return json({ error: 'Prompt belongs to a different session' }, 409);
			if (replyStatus === 'forbidden') return json({ error: 'Not yours' }, 403);
			if (replyStatus === 'bad') return json({ error: 'Bad request' }, 400);
			if (replyStatus === 'network') throw new TypeError('Failed to fetch');
			if (replyStatus === 'answered_before') return json({ ok: true, idempotent: true, ...(refuse ? { refused: 'unrecognised_answer' } : {}) });
			return json(refuse ? { ok: true, refused: 'unrecognised_answer' } : { ok: true });
		}
		if (url.endsWith('/threads/t1')) return json({ thread: null });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
	void store.sendMessage('clean up');
	await settle();
	before?.();
	await settle();
	run.send('prompt', { question: '⚠ Command: x', options, promptId: 'p1', agent: 'lynox', ...(consent ? { consent } : {}) });
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	const bar = target.querySelector<HTMLElement>('[data-prompt-kind="permission"]');
	if (!bar) throw new Error('the prompt did not render — the fixture is wrong');
	return bar;
}

const buttons = (bar: HTMLElement): string[] => [...bar.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim()).filter((s) => s !== '');
const click = async (bar: HTMLElement, text: string): Promise<void> => {
	const button = [...bar.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === text);
	if (!button) throw new Error(`no button "${text}" in ${JSON.stringify(buttons(bar))}`);
	button.click();
	await settle();
};

describe('the engine\'s own confirmation', () => {
	for (const locale of ['de', 'en'] as const) {
		it(`guard, ${locale}: shows the keys in the chat's words and sends the key`, async () => {
			i18n.setLocale(locale);
			const bar = await renderPrompt(['allow', 'deny'], 'guard');
			expect(buttons(bar)).toEqual(expect.arrayContaining([i18n.t('chat.allow'), i18n.t('chat.deny')]));
			expect(buttons(bar)).not.toContain('allow');
			await click(bar, i18n.t('chat.allow'));
			expect(replies.map((r) => r.answer)).toEqual(['allow']);
		});

		it(`deep, ${locale}: three keys, each sent as itself`, async () => {
			i18n.setLocale(locale);
			const bar = await renderPrompt(['deep', 'balanced', 'cancel'], 'deep');
			expect(buttons(bar)).toEqual(expect.arrayContaining([i18n.t('chat.consent_allow_deep'), i18n.t('chat.consent_run_balanced'), i18n.t('chat.consent_cancel')]));
			await click(bar, i18n.t('chat.consent_run_balanced'));
			expect(replies.map((r) => r.answer)).toEqual(['balanced']);
		});
	}

	it('a click on allow is acknowledged while the run goes on; on deny it says denied', async () => {
		i18n.setLocale('de');
		let bar = await renderPrompt(['allow', 'deny'], 'guard');
		await click(bar, i18n.t('chat.allow'));
		expect(target.textContent).toContain(i18n.t('chat.permission_running'));
		run.close();
		if (component) svelte.unmount(component);
		component = undefined;
		target.innerHTML = '';
		store.newChat();
		replies = [];
		bar = await renderPrompt(['allow', 'deny'], 'guard');
		await click(bar, i18n.t('chat.deny'));
		expect(target.textContent).toContain(i18n.t('chat.permission_denied_running'));
	});

	it('an answer the engine reads as none of the keys is said, not a silent no', async () => {
		i18n.setLocale('de');
		await renderPrompt(['allow', 'deny'], 'guard');
		refuse = true;
		await store.replyPermission('Erlauben');
		await settle();
		expect(replies.map((r) => r.answer)).toEqual(['Erlauben']);
		expect(store.getChatError()).toBe(i18n.t('chat.consent_unrecognised'));
	});
});

describe('a question the model wrote', () => {
	for (const options of [['Allow', 'Deny', '\x00'], ['Allow deep', 'Run on balanced', 'Cancel', '\x00'], ['allow', 'deny']]) {
		it(`offering ${options.filter((o) => o !== '\x00').join(' / ')} without the marker is an ordinary question`, async () => {
			i18n.setLocale('de');
			const bar = await renderPrompt(options);
			// Not the consent card: no button in the consent card's words, and each option is its own button.
			expect(buttons(bar)).not.toContain(i18n.t('chat.allow'));
			expect(buttons(bar)).not.toContain(i18n.t('chat.consent_run_balanced'));
			const first = options[0]!;
			await click(bar, first);
			// It sends what the button says — never a key the card would have sent for it.
			expect(replies.map((r) => r.answer)).toEqual([first]);
		});
	}
});

describe('the model\'s batched questions', () => {
	const batch = (): void => run.send('tool_call', {
		name: 'ask_user', id: 'tc1', status: 'running',
		input: { questions: [{ question: 'Continue?', options: ['allow', 'deny'] }, { question: 'And then?', options: ['allow', 'deny'] }] },
	});

	it('control: a model\'s question while its batch runs is shown as the batch', async () => {
		i18n.setLocale('de');
		await renderPrompt(['allow', 'deny'], undefined, batch).catch(() => null);
		expect(target.textContent).toContain('Continue?');
	});

	it('never take the engine\'s confirmation into the batch: its own card is shown', async () => {
		i18n.setLocale('de');
		const bar = await renderPrompt(['allow', 'deny'], 'guard', batch);
		expect(buttons(bar)).toEqual(expect.arrayContaining([i18n.t('chat.allow'), i18n.t('chat.deny')]));
		expect(target.textContent).not.toContain('Continue?');
	});
});

describe('text typed as the answer', () => {
	const type = async (text: string): Promise<void> => {
		const area = target.querySelector<HTMLTextAreaElement>('textarea');
		if (!area) throw new Error('no message field');
		area.value = text;
		area.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		const send = [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === i18n.t('chat.send'));
		if (!send) throw new Error('no send button');
		send.click();
		await settle();
	};
	const lines = (): string[] => [...target.querySelectorAll('[data-typed-answer]')].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim());

	for (const locale of ['de', 'en'] as const) {
		it(`${locale}: to the engine's confirmation, it stays in the chat where the question stood, and the refusal stands beside it`, async () => {
			i18n.setLocale(locale);
			await renderPrompt(['allow', 'deny'], 'guard');
			refuse = true;
			await type(locale === 'de' ? 'ja' : 'yes');
			expect(replies.map((r) => r.answer)).toEqual([locale === 'de' ? 'ja' : 'yes']);
			expect(lines()).toEqual([`${i18n.t('chat.typed_answer')} "${locale === 'de' ? 'ja' : 'yes'}"`]);
			expect(store.getChatError()).toBe(i18n.t('chat.consent_unrecognised'));
			// The run's result comes after the line, not over it.
			run.send('done', { result: 'Not sent to the AI model.' });
			await settle();
			svelte.flushSync();
			expect(lines()).toHaveLength(1);
			expect(target.textContent).toContain('Not sent to the AI model.');
			const text = target.textContent ?? '';
			expect(text.indexOf(i18n.t('chat.typed_answer'))).toBeLessThan(text.indexOf('Not sent to the AI model.'));
		});
	}

	it('a click leaves no line: the button already says what was answered', async () => {
		i18n.setLocale('de');
		const bar = await renderPrompt(['allow', 'deny'], 'guard');
		await click(bar, i18n.t('chat.allow'));
		expect(lines()).toEqual([]);
	});

	it('one the engine did not take (a key it refused) is not kept: it was not given', async () => {
		i18n.setLocale('de');
		await renderPrompt(['allow', 'deny'], 'guard');
		keyRefused = true;
		await type('password: Hunter2!x');
		expect(replies.map((r) => r.answer)).toEqual(['password: Hunter2!x']);
		expect(lines()).toEqual([]);
		expect(JSON.stringify(store.getMessages())).not.toContain('Hunter2');
	});

	const stored = (): string => { try { return localStorage.getItem('lynox-chat') ?? ''; } catch { return ''; } };
	for (const status of ['answered_before', 'unknown', 'conflict', 'forbidden', 'bad', 'network'] as const) {
		for (const unrecognised of [false, true]) {
			it(`one the engine did not take as this answer (${status}${unrecognised ? ', read as no key' : ''}) is neither shown nor stored`, async () => {
				i18n.setLocale('de');
				await renderPrompt(['allow', 'deny'], 'guard');
				replyStatus = status;
				refuse = unrecognised;
				await type('password: Hunter2!x');
				await new Promise((r) => setTimeout(r, 1200)); // the one retry after a failed send
				await settle();
				expect(replies.length).toBeGreaterThanOrEqual(1);
				expect(lines()).toEqual([]);
				expect(JSON.stringify(store.getMessages())).not.toContain('Hunter2');
				expect(stored()).not.toContain('Hunter2');
			});
		}
	}

	it('control: one the engine took now is shown, and kept with the chat', async () => {
		i18n.setLocale('de');
		await renderPrompt(['allow', 'deny'], 'guard');
		await type('ja');
		expect(lines()).toEqual([`${i18n.t('chat.typed_answer')} "ja"`]);
		expect(JSON.stringify(store.getMessages())).toContain('"type":"answer"');
	});

	it('goes into the reply of the run that asked, also when a message waits behind it', async () => {
		i18n.setLocale('de');
		await renderPrompt(['allow', 'deny'], 'guard');
		void store.sendMessage('and then the next thing');
		await settle();
		refuse = true;
		await type('ja');
		const msgs = store.getMessages();
		const holder = msgs.findIndex((m) => m.blocks?.some((b) => b.type === 'answer'));
		const waiting = msgs.findIndex((m) => m.role === 'user' && m.content === 'and then the next thing');
		expect(waiting).toBeGreaterThan(-1);
		expect(holder).toBeGreaterThan(-1);
		expect(holder).toBeLessThan(waiting);
		expect(lines()).toHaveLength(1);
	});

	it('to a question the model wrote, it adds no line', async () => {
		i18n.setLocale('de');
		await renderPrompt(['Allow', 'Deny', '\x00']);
		await type('ja');
		expect(replies.map((r) => r.answer)).toEqual(['ja']);
		expect(lines()).toEqual([]);
	});
});
