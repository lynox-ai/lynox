import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readable } from 'svelte/store';

// A run refused because nothing of the AI budget is free for it (`run_blocked` with the reason
// `hold_exhausted`) is shown as a note in the owner's language only: the engine's own sentence is
// kept on the note but not shown as a detail line, and it is not rendered as the reply either.

// As in chatview-thinking-loop-model: the client entry of `svelte` stands in for its server entry.
const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};

const toasts: string[] = [];
vi.mock('../stores/toast.svelte.js', async (importActual) => ({
	...(await importActual<typeof import('../stores/toast.svelte.js')>()),
	addToast: (message: string) => { toasts.push(message); return 1; },
}));
vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));

const ENGINE_SENTENCE = 'Nothing is left of the AI budget for this run right now. If another task is running, you can continue once it has finished; otherwise buy a credit pack or wait for your next billing period.';
const DE = 'Für diesen Lauf ist vom KI-Budget gerade nichts mehr frei. Läuft eine andere Aufgabe, kannst du weitermachen, sobald sie fertig ist; sonst kauf ein Credit-Pack oder warte auf die nächste Abrechnungsperiode.';

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

let svelte: SvelteClient;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;

/** Runs one turn whose stream is a `run_blocked` warning (with `reason`, when given) and `done`. */
async function blockedTurn(reason: string | undefined): Promise<typeof import('../stores/chat.svelte.js')> {
	const enc = new TextEncoder();
	const warning = { code: 'run_blocked', detail: ENGINE_SENTENCE, agent: 'lynox', ...(reason ? { reason } : {}) };
	const body = `event: warning\ndata: ${JSON.stringify(warning)}\n\nevent: done\ndata: ${JSON.stringify({ result: `Run blocked: ${ENGINE_SENTENCE}` })}\n\n`;
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 'hold' });
		if (url.endsWith('/run')) return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/config')) return json({});
		if (url.endsWith('/onboarding/status')) return json({ knowledgeDone: true, skipped: true, durableMemory: false, firstSessionAt: 'x' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
	const store = await import('../stores/chat.svelte.js');
	await store.sendMessage('Werte aus');
	await settle();
	return store;
}

async function mountChat(): Promise<void> {
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	svelte.flushSync();
}

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	svelte = (await import('svelte')) as unknown as SvelteClient;
	(await import('../stores/settings-viewer.svelte.js')).resetSettingsViewer();
	(await import('../i18n.svelte.js')).setLocale('de');
	toasts.length = 0;
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(async () => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	localStorage.clear();
	(await import('../stores/chat.svelte.js')).newChat();
	(await import('../i18n.svelte.js')).setLocale('de');
});

describe('a run refused because nothing of the AI budget is free', () => {
	it('becomes a hold_exhausted note with the engine sentence as its detail, not a reply', async () => {
		// Kills: dropping the reason branch (the raw engine text would be the reply and a toast).
		const store = await blockedTurn('hold_exhausted');
		const last = store.getMessages().at(-1);
		expect(last?.note).toEqual({ code: 'hold_exhausted', detail: ENGINE_SENTENCE });
		expect(last?.content ?? '').toBe('');
		expect(toasts).toEqual([]);
	});

	it('renders only the German sentence in German, and the English one once in English', async () => {
		// Kills: a note code without its i18n line (the generic error text would show instead), and
		// rendering the engine sentence as the detail line (German mode would mix in the English
		// text; English mode would show the sentence twice).
		await blockedTurn('hold_exhausted');
		await mountChat();
		expect(target.textContent).toContain(DE);
		expect(target.textContent).not.toContain(ENGINE_SENTENCE);
		(await import('../i18n.svelte.js')).setLocale('en');
		svelte.flushSync();
		await settle();
		svelte.flushSync();
		expect(target.textContent).not.toContain(DE);
		expect(target.textContent?.split(ENGINE_SENTENCE).length).toBe(2);
		const details = [...target.querySelectorAll('.font-mono')].map((el) => el.textContent ?? '');
		expect(details.some((t) => t.includes(ENGINE_SENTENCE))).toBe(false);
	});

	it('a run_blocked without that reason stays a toast and the inline reply, as before', async () => {
		// Kills: treating every run_blocked as hold_exhausted.
		const store = await blockedTurn(undefined);
		const last = store.getMessages().at(-1);
		expect(last?.note).toBeUndefined();
		expect(last?.content).toBe(`Run blocked: ${ENGINE_SENTENCE}`);
		expect(toasts).toHaveLength(1);
	});
});
