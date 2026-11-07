// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The engine retries a reply the AI service cut off; when the last attempt is cut off too, the
// run's terminal `error` event carries `code: 'stream_incomplete'`. The chat names that case in
// the reader's language, in the banner and the toast, from the code and never from the text,
// which stays the detail. Any other error keeps the general wording.

type Store = typeof import('./chat.svelte.js');
type I18n = typeof import('../i18n.svelte.js');
type Toasts = typeof import('./toast.svelte.js');

function sseStream(): { body: ReadableStream<Uint8Array>; send: (type: string, data: unknown, seq?: number) => void; close: () => void } {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return {
		body,
		send: (type, data, seq) => ctrl.enqueue(enc.encode(`${seq ? `id: ${seq}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)),
		close: () => ctrl.close(),
	};
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;
let i18n: I18n;
let toasts: Toasts;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	i18n = await import('../i18n.svelte.js');
	toasts = await import('./toast.svelte.js');
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Starts a run, streams a piece of the reply, then ends it with the terminal `error` event `errorData`. */
async function runEndingIn(errorData: Record<string, unknown>): Promise<void> {
	const stream = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [], activeRun: null });
		return json({}, 404);
	}));
	const sent = store.sendMessage('summarise it');
	await settle();
	stream.send('text', { text: 'partial answer' }, 1);
	await settle();
	stream.send('error', errorData, 2);
	await settle();
	stream.close();
	await sent;
	await settle();
}

const RAW = 'the AI service ended the reply before it was finished';
const lastToast = (): string | undefined => toasts.getToasts().at(-1)?.message;

describe('a reply the AI service cut off on every attempt', () => {
	it('is named in German in the banner and the toast; the raw text stays the detail', async () => {
		i18n.setLocale('de');
		await runEndingIn({ error: RAW, fatal: true, code: 'stream_incomplete' });

		const text = 'Der KI-Dienst hat die Antwort abgebrochen, bevor sie fertig war, auch beim letzten Versuch. Steht oben ein Teil davon, ist er unvollständig. Versuche es nochmal.';
		expect(store.getChatError()).toBe(text);
		expect(lastToast()).toBe('Diese Antwort ist fehlgeschlagen.');
		expect(store.getChatErrorDetail()).toBe(RAW);
		// The part that arrived stays where it was.
		expect(store.getMessages().filter((m) => m.role === 'assistant').at(-1)?.content).toBe('partial answer');
	});

	it('is named in English in the banner and the toast', async () => {
		i18n.setLocale('en');
		await runEndingIn({ error: RAW, fatal: true, code: 'stream_incomplete' });

		const text = 'The AI service cut the reply off before it was finished, on the last attempt too. Any part of it shown above is incomplete. Try again.';
		expect(store.getChatError()).toBe(text);
		expect(lastToast()).toBe('This response failed.');
	});

	it('control: an error without the code keeps the general wording and the raw text in the toast', async () => {
		i18n.setLocale('en');
		await runEndingIn({ error: 'provider exploded', fatal: true });

		expect(store.getChatError()).toBe(i18n.t('chat.error_start'));
		expect(lastToast()).toBe('This response failed: provider exploded');
	});

	it('control: the same text without the code is not taken for this case', async () => {
		i18n.setLocale('en');
		await runEndingIn({ error: RAW, fatal: true });

		expect(store.getChatError()).toBe(i18n.t('chat.error_start'));
		expect(lastToast()).toBe(`This response failed: ${RAW}`);
	});
});
