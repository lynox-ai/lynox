import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// A question's card says how long it has left only when it matters, in words: nothing with an hour
// or more, whole minutes under an hour, seconds under a minute in the warning colour. It counts from
// the time the server says the question has left, so a reload does not restart a full day; without
// that time the card shows none.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
let svelte: SvelteClient;

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));

function sseStream(): { body: ReadableStream<Uint8Array>; send: (type: string, data: unknown) => void; close: () => void } {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return {
		body,
		send: (type, data) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
		close: () => { try { ctrl.close(); } catch { /* closed already */ } },
	};
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

const DAY = 24 * 60 * 60_000;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let store: typeof import('../stores/chat.svelte.js');
let i18n: typeof import('../i18n.svelte.js');
let run: ReturnType<typeof sseStream> | undefined;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	store = await import('../stores/chat.svelte.js');
	i18n = await import('../i18n.svelte.js');
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	run?.close();
	run = undefined;
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	store.newChat();
	vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	svelte.flushSync();
}

/** A live question: the engine asks with `extra` (its time fields), the chat shows the card. */
async function ask(locale: 'de' | 'en', extra: Record<string, unknown>): Promise<void> {
	i18n.setLocale(locale);
	const stream = sseStream();
	run = stream;
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/sessions/t1/pending-prompt')) return json({ pending: false });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
	void store.sendMessage('go');
	await settle();
	stream.send('prompt', { question: 'Send the offer to the customer?', options: ['Yes', 'No'], promptId: 'p1', agent: 'lynox', ...extra });
	await settle();
	await mount();
}

/** A reload: the thread's open question comes back from `/pending-prompt` with `extra`. */
async function reload(locale: 'de' | 'en', extra: Record<string, unknown>): Promise<void> {
	i18n.setLocale(locale);
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.includes('/threads/t2/messages')) return json({ messages: [{ role: 'user', content: 'go' }], activeRun: null });
		if (url.endsWith('/sessions/t2/pending-prompt')) {
			return json({ pending: true, promptId: 'p2', promptType: 'ask_user', kind: 'single', question: 'Send the offer to the customer?', options: ['Yes', 'No'], createdAt: '2026-11-19 05:00:00', ...extra });
		}
		if (url.endsWith('/sessions')) return json({ sessionId: 't2' });
		if (url.endsWith('/config')) return json({ viewer: 'owner', locks: {} });
		if (url.endsWith('/onboarding/status')) return json({ knowledgeDone: true, skipped: true, durableMemory: false, firstSessionAt: 'x' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
	await store.resumeThread('t2');
	await settle();
	await mount();
}

const expiry = (): Element | null => target.querySelector('[data-prompt-expiry]');
const card = (): string => (target.textContent ?? '');

describe('the time a question has left, on its card', () => {
	for (const locale of ['de', 'en'] as const) {
		it(`${locale}: an hour or more left shows no number`, async () => {
			await ask(locale, { timeoutMs: DAY, expiresInMs: DAY });
			expect(card()).toContain('Send the offer to the customer?');
			expect(expiry()).toBeNull();
			expect(card()).not.toMatch(/\d+:\d{2}:\d{2}/);
		});

		it(`${locale}: under an hour, whole minutes in words; no tooltip, no live announcement`, async () => {
			await ask(locale, { timeoutMs: DAY, expiresInMs: 42 * 60_000 + 30_000 });
			const el = expiry();
			expect(el?.textContent).toBe(locale === 'de' ? 'Läuft ab in 42 Min.' : 'Expires in 42 min');
			expect(el?.className).not.toContain('text-warning');
			expect(el?.hasAttribute('title')).toBe(false);
			expect(el?.closest('[aria-live]')).toBeNull();
		});

		it(`${locale}: under a minute, seconds in the warning colour`, async () => {
			await ask(locale, { timeoutMs: DAY, expiresInMs: 42_000 });
			const el = expiry();
			expect(el?.textContent).toMatch(locale === 'de' ? /^Läuft ab in (41|42) s$/ : /^Expires in (41|42) s$/);
			expect(el?.className).toContain('text-warning');
		});
	}

	it('an engine that does not say the time left: no countdown, not one guessed from a full day', async () => {
		await ask('de', { timeoutMs: 120_000 });
		expect(card()).toContain('Send the offer to the customer?');
		expect(expiry()).toBeNull();
	});
});

describe('after a reload', () => {
	it('counts from the time the server says is left, not a restarted day', async () => {
		await reload('de', { timeoutMs: DAY, expiresInMs: 5 * 60_000 + 10_000 });
		expect(card()).toContain('Send the offer to the customer?');
		expect(expiry()?.textContent).toBe('Läuft ab in 5 Min.');
	});

	it('without the time left (an older engine), shows none', async () => {
		await reload('en', { timeoutMs: DAY });
		expect(card()).toContain('Send the offer to the customer?');
		expect(expiry()).toBeNull();
	});
});
