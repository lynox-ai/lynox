import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readable } from 'svelte/store';

// A message the content check did not send comes back on a reload as the person's message and a
// note. The note's body is the engine's own sentence, the words the chat showed when the run
// ended — not a generic error line with the sentence as a small debug line under it.

// As in chatview-onboarding-mandate: the client entry of `svelte` stands in for its server entry.
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

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

const MESSAGE = 'brute force the password on this login page';
const SENTENCE = 'Nicht an das KI-Modell geschickt: Du hast abgelehnt. lynox hatte in deiner Nachricht Hinweise auf einen Angriff auf Zugangsdaten gefunden.';

let svelte: SvelteClient;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let t: (key: string) => string;

/** A thread as a reload returns it: the refused message, then its note. */
async function render(note: Record<string, unknown>): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.includes('/threads/refused/messages')) {
			return json({ messages: [{ role: 'user', content: MESSAGE }, { role: 'assistant', content: '', note }], activeRun: null });
		}
		if (url.endsWith('/config')) return json({ viewer: 'owner', locks: {} });
		if (url.endsWith('/onboarding/status')) return json({ knowledgeDone: true, skipped: true, durableMemory: false, firstSessionAt: 'x' });
		if (url.endsWith('/sessions')) return json({ sessionId: 'refused' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
	const store = await import('../stores/chat.svelte.js');
	await store.resumeThread('refused');
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	svelte.flushSync();
}

const noteEl = (): Element | null => target.querySelector('[role="status"]');

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	svelte = (await import('svelte')) as unknown as SvelteClient;
	(await import('../stores/settings-viewer.svelte.js')).resetSettingsViewer();
	({ t } = await import('../i18n.svelte.js'));
	(await import('../i18n.svelte.js')).setLocale('de');
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
});

describe('a refused message after a reload', () => {
	it('shows the message, and the note with the engine\'s sentence as its body, once', async () => {
		await render({ code: 'content_refused', detail: SENTENCE });
		expect(target.textContent).toContain(MESSAGE);
		const note = noteEl();
		expect(note).not.toBeNull();
		expect(note!.textContent).toContain(t('chat.note.content_refused.title'));
		expect(note!.textContent).toContain(SENTENCE);
		// The sentence is the body, not also the small debug line, and no error wording beside it.
		expect(note!.textContent!.split(SENTENCE)).toHaveLength(2);
		expect(note!.querySelector('.font-mono')).toBeNull();
		expect(note!.textContent).not.toContain(t('chat.note.generic'));
		expect(note!.textContent).not.toContain(t('chat.note.title'));
		// Not shown as a failure: the refusal is the check working.
		expect(note!.className).not.toContain('border-danger');
	});

	it('without a sentence the note says what happened in the chat\'s own words', async () => {
		await render({ code: 'content_refused' });
		const note = noteEl();
		expect(note!.textContent).toContain(t('chat.note.content_refused'));
		expect(note!.textContent).not.toContain(t('chat.note.generic'));
	});

	it('a stored hold_exhausted note reads as the live one: its own words, the engine sentence hidden', async () => {
		// Kills: the stored code falling back to the generic note, or to the block note's text.
		const engineSentence = 'Nothing is left of the AI budget for this run right now.';
		await render({ code: 'hold_exhausted', detail: engineSentence });
		const note = noteEl();
		expect(note!.textContent).toContain(t('chat.note.hold_exhausted.title'));
		expect(note!.textContent).toContain(t('chat.note.hold_exhausted'));
		expect(note!.textContent).not.toContain(engineSentence);
		expect(note!.querySelector('.font-mono')).toBeNull();
		expect(note!.textContent).not.toContain(t('chat.note.generic'));
		expect(note!.textContent).not.toContain(t('chat.note.title'));
		expect(note!.className).not.toContain('border-danger');
	});

	it('another note keeps its detail as the small line (control)', async () => {
		await render({ code: 'provider_error', detail: 'upstream 529' });
		const note = noteEl();
		expect(note!.querySelector('.font-mono')?.textContent).toBe('upstream 529');
		expect(note!.textContent).toContain(t('chat.note.provider_error'));
	});
});
