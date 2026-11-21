import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

// When the engine ends a run with a sentence of its own (the content check refused the message, a
// budget or a run hook blocked it), `done` says so (`notice`). The chat then
// shows that sentence as a lynox note — the one a reload shows — without the AI mark. A model
// reply keeps the mark.

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
		close: () => { try { ctrl.close(); } catch { /* closed already */ } },
	};
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

const REFUSED = 'Nicht an das KI-Modell geschickt: Du hast abgelehnt. lynox hatte in deiner Nachricht Hinweise auf einen Angriff auf Zugangsdaten gefunden.';
const REASON = 'AI budget for this period reached. Buy a credit pack to continue now, or wait for your next billing cycle.';

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let store: typeof import('../stores/chat.svelte.js');
let i18n: typeof import('../i18n.svelte.js');
let run: ReturnType<typeof sseStream>;

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
	run.close();
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	store.newChat();
	vi.unstubAllGlobals();
});

/** Sends a message, renders the chat, and ends the run with `done` = `data`. */
async function endRun(locale: 'de' | 'en', data: Record<string, unknown>): Promise<void> {
	i18n.setLocale(locale);
	run = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/threads/t1')) return json({ thread: null });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
	void store.sendMessage('hello');
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	run.send('done', data);
	await settle();
	svelte.flushSync();
}

const notice = (): Element | null => target.querySelector('[data-engine-notice]');
const reply = (): Element | null => target.querySelector('.ai-message-wrap');
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('a run that ended with lynox\'s own sentence', () => {
	for (const locale of ['de', 'en'] as const) {
		it(`${locale}: a refusal of the content check is the note a reload shows, without the AI mark`, async () => {
			await endRun(locale, { result: REFUSED, notice: 'content_refused' });
			expect(text(notice())).toBe(`${i18n.t('chat.note.content_refused.title')} ${REFUSED}`);
			expect(target.querySelector('.ai-badge')).toBeNull();
			expect(reply()?.getAttribute('data-ai-generated')).toBe('false');
			// The info style, not a failure.
			expect(notice()?.querySelector('[role="status"]')?.className).toContain('border-border');
			// No reply to copy under lynox's own note: no actions, as after a reload.
			expect(reply()?.querySelector('button')).toBeNull();
		});

		it(`${locale}: a run a hook blocked names the check, says it was not sent, and keeps the reason as the engine said it`, async () => {
			await endRun(locale, { result: `Run blocked: ${REASON}`, notice: 'run_blocked' });
			const el = notice();
			expect(text(el)).toBe(`${i18n.t('chat.note.run_blocked.title')} ${i18n.t('chat.note.run_blocked')} ${REASON}`);
			const line = el?.querySelector('.font-mono');
			expect(line?.textContent).toBe(REASON);
			// The instance's language, not marked English.
			expect(el?.querySelector('[lang]')).toBeNull();
			expect(target.querySelector('.ai-badge')).toBeNull();
			expect(el?.querySelector('[role="status"]')?.className).toContain('border-border');
		});
	}

	it('de: the words of the blocked run\'s note', async () => {
		await endRun('de', { result: `Run blocked: ${REASON}`, notice: 'run_blocked' });
		expect(text(notice())).toBe(`Vor dem Senden geprüft Diese Nachricht ging nicht an das KI-Modell. ${REASON}`);
	});
});

describe('control: the model\'s words keep the AI mark', () => {
	it('a result without notice is the model\'s reply', async () => {
		await endRun('de', { result: 'Paris.' });
		expect(notice()).toBeNull();
		expect(target.querySelector('.ai-badge')).not.toBeNull();
		expect(reply()?.getAttribute('data-ai-generated')).toBe('true');
		expect(text(reply())).toContain('Paris.');
		// A model reply keeps its actions (copy).
		expect(reply()?.querySelector('button')).not.toBeNull();
	});

	it('a notice the chat does not take (a question that may be the model\'s) is shown as before, with the mark', async () => {
		await endRun('de', { result: 'Approve the refund?', notice: 'input_required' });
		expect(notice()).toBeNull();
		expect(target.querySelector('.ai-badge')).not.toBeNull();
	});

	it('a reply the model streamed stays the model\'s, whatever done says', async () => {
		i18n.setLocale('de');
		run = sseStream();
		vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
			if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
			if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
			return json({});
		}));
		void store.sendMessage('hello');
		await settle();
		const { default: ChatView } = await import('./ChatView.svelte');
		component = svelte.mount(ChatView, { target });
		svelte.flushSync();
		run.send('text', { text: 'Streamed answer.', agent: 'lynox' });
		await settle();
		run.send('done', { result: 'Streamed answer.', notice: 'content_refused' });
		await settle();
		svelte.flushSync();
		expect(notice()).toBeNull();
		expect(target.querySelector('.ai-badge')).not.toBeNull();
	});
});
