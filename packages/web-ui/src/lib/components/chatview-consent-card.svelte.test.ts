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
let closed: boolean;
let i18n: typeof import('../i18n.svelte.js');

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	store = await import('../stores/chat.svelte.js');
	i18n = await import('../i18n.svelte.js');
	replies = [];
	refuse = false;
	closed = false;
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
async function renderPrompt(options: string[], consent?: string, before?: () => void, extra: Record<string, unknown> = {}): Promise<HTMLElement> {
	run = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/sessions/t1/reply')) {
			replies.push(JSON.parse(String(init?.body ?? '{}')) as { answer?: unknown });
			if (closed) return new Response(JSON.stringify({ code: 'timed_out' }), { status: 410, headers: { 'Content-Type': 'application/json' } });
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
	run.send('prompt', { question: '⚠ Command: x', options, promptId: 'p1', agent: 'lynox', ...(consent ? { consent } : {}), ...extra });
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

describe('a tool\'s own confirmation', () => {
	const KINDS = [
		{ kind: 'send', keys: ['send', 'cancel'], labels: ['chat.consent.send', 'chat.consent_cancel'] },
		{ kind: 'merge', keys: ['merge', 'cancel'], labels: ['chat.consent.merge', 'chat.consent_cancel'] },
		{ kind: 'apply', keys: ['apply', 'cancel'], labels: ['chat.consent.apply', 'chat.consent_cancel'] },
		{ kind: 'retire', keys: ['retire', 'cancel'], labels: ['chat.consent.retire', 'chat.consent_cancel'] },
		{ kind: 'plan', keys: ['proceed', 'adjust', 'cancel'], labels: ['chat.consent.proceed', 'chat.consent.adjust', 'chat.consent_cancel'] },
	] as const;
	for (const locale of ['de', 'en'] as const) {
		for (const k of KINDS) {
			it(`${k.kind}, ${locale}: the keys in the chat's words, no skip, and the first sends its key`, async () => {
				i18n.setLocale(locale);
				const bar = await renderPrompt([...k.keys], k.kind);
				expect(buttons(bar)).toEqual(k.labels.map((l) => i18n.t(l)));
				for (const key of k.keys) expect(buttons(bar)).not.toContain(key);
				expect(bar.querySelector(`[aria-label="${i18n.t('chat.dismiss')}"]`)).toBeNull();
				await click(bar, i18n.t(k.labels[0]));
				expect(replies.map((r) => r.answer)).toEqual([k.keys[0]]);
			});
		}

		it(`google, ${locale}: the confirming button names the action; a delete is red`, async () => {
			i18n.setLocale(locale);
			const bar = await renderPrompt(['confirm', 'cancel'], 'google', undefined, { consentAction: 'delete' });
			expect(buttons(bar)).toEqual([i18n.t('chat.consent.action.delete'), i18n.t('chat.consent_cancel')]);
			const del = bar.querySelector<HTMLElement>('[data-consent-key="confirm"]')!;
			expect(del.className).toContain('text-danger');
			await click(bar, i18n.t('chat.consent.action.delete'));
			expect(replies.map((r) => r.answer)).toEqual(['confirm']);
		});
	}

	it('google: a share is the primary action, not red; an unknown action falls back to a plain confirm', async () => {
		i18n.setLocale('de');
		let bar = await renderPrompt(['confirm', 'cancel'], 'google', undefined, { consentAction: 'share' });
		expect(buttons(bar)[0]).toBe('Freigeben');
		expect(bar.querySelector<HTMLElement>('[data-consent-key="confirm"]')!.className).not.toContain('text-danger');
		run.close();
		if (component) svelte.unmount(component);
		component = undefined;
		target.innerHTML = '';
		store.newChat();
		bar = await renderPrompt(['confirm', 'cancel'], 'google', undefined, { consentAction: 'erase' });
		expect(buttons(bar)[0]).toBe('Bestätigen');
	});

	it('an adjust on a plan is acknowledged as neither approved nor denied', async () => {
		i18n.setLocale('de');
		const bar = await renderPrompt(['proceed', 'adjust', 'cancel'], 'plan');
		await click(bar, i18n.t('chat.consent.adjust'));
		expect(replies.map((r) => r.answer)).toEqual(['adjust']);
		expect(target.textContent).not.toContain(i18n.t('chat.permission_denied_running'));
		expect(target.textContent).not.toContain(i18n.t('chat.permission_running'));
	});

	it('a plan says that writing is a way to answer; the others do not', async () => {
		i18n.setLocale('de');
		let bar = await renderPrompt(['proceed', 'adjust', 'cancel'], 'plan');
		expect(bar.querySelector('[data-consent-hint]')?.textContent).toBe('Oder schreib, was du ändern willst.');
		run.close();
		if (component) svelte.unmount(component);
		component = undefined;
		target.innerHTML = '';
		store.newChat();
		bar = await renderPrompt(['send', 'cancel'], 'send');
		expect(bar.querySelector('[data-consent-hint]')).toBeNull();
	});

	it('the question keeps its markdown: a tool\'s card is no <pre>', async () => {
		i18n.setLocale('en');
		const bar = await renderPrompt(['send', 'cancel'], 'send', undefined, { question: '**Send email?**', segments: [{ kind: 'frame', text: '**Send email?**' }] });
		expect(bar.querySelector('pre')).toBeNull();
		expect(bar.querySelector('strong')?.textContent).toBe('Send email?');
	});

	for (const [kind, keys, typed] of [['send', ['send', 'cancel'], 'send'], ['google', ['confirm', 'cancel'], 'confirm'], ['guard', ['allow', 'deny'], 'allow'], ['merge', ['merge', 'cancel'], 'ja']] as const) {
		it(`${kind}: typed text — even its key — is no answer: it stays in the field with a hint`, async () => {
			i18n.setLocale('de');
			await renderPrompt([...keys], kind);
			const field = target.querySelector<HTMLTextAreaElement>('textarea')!;
			field.value = typed;
			field.dispatchEvent(new Event('input', { bubbles: true }));
			await settle();
			field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
			await settle();
			expect(replies, 'nothing was answered').toEqual([]);
			expect(target.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(typed);
			expect(target.querySelector('[data-consent-typed]')?.textContent).toBe('Diese Frage beantwortest du mit ihren Knöpfen. Dein Text bleibt hier, bis du geantwortet hast.');
			expect(target.querySelector('[data-prompt-kind="permission"]')).not.toBeNull();
		});
	}

	it('plan: typed text is sent as the change asked for, and comes back to the field if the question closed', async () => {
		i18n.setLocale('de');
		await renderPrompt(['proceed', 'adjust', 'cancel'], 'plan');
		closed = true;
		const field = target.querySelector<HTMLTextAreaElement>('textarea')!;
		field.value = 'Ohne Schritt 3';
		field.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		await settle();
		await settle();
		expect(replies.map((r) => r.answer)).toEqual(['Ohne Schritt 3']);
		expect(target.querySelector('[data-consent-typed]')).toBeNull();
		expect(target.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Ohne Schritt 3');
	});

	it('typed text to a send is refused visibly, as for the guard', async () => {
		i18n.setLocale('de');
		await renderPrompt(['send', 'cancel'], 'send');
		refuse = true;
		await store.replyPermission('ja');
		await settle();
		expect(replies.map((r) => r.answer)).toEqual(['ja']);
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
