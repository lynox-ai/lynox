// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// No AI provider key yet: the run is refused with `code: 'llm_not_configured'`, and
// the chat says why in the reader's language. The owner reads which provider lacks a key and
// where to add it; a mandate, which cannot open that page, reads that only the owner can.

type Store = typeof import('./chat.svelte.js');
type I18n = typeof import('../i18n.svelte.js');

vi.mock('./toast.svelte.js', () => ({ addToast: () => 1 }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let store: Store;
let i18n: I18n;
let runAnswer: Response;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('window', { addEventListener: () => {} });
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/run')) return runAnswer;
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		return json({ messages: [], activeRun: null });
	}));
	vi.resetModules();
	store = await import('./chat.svelte.js');
	i18n = await import('../i18n.svelte.js');
});
afterEach(() => { vi.unstubAllGlobals(); });

async function sendRefused(body: unknown): Promise<void> {
	runAnswer = json(body, 400);
	await store.sendMessage('hello');
}

describe('a message sent without an AI provider key', () => {
	it('tells the owner which provider lacks a key and the settings page to add it on', async () => {
		i18n.setLocale('de');
		await sendRefused({ error: 'No key is stored for Mistral yet. Open Settings → Configuration and add one.', code: 'llm_not_configured', may_configure: true, provider: 'Mistral' });

		expect(store.getChatError()).toBe('Für Mistral ist noch kein Schlüssel hinterlegt. Öffne Einstellungen → Konfiguration und füg einen hinzu.');
		const user = store.getMessages().find((m) => m.role === 'user' && m.content === 'hello');
		expect(user?.failed, 'kept, failed').toBe(true);
	});

	it('tells the owner in English when the page is in English', async () => {
		i18n.setLocale('en');
		await sendRefused({ error: 'x', code: 'llm_not_configured', may_configure: true, provider: 'Anthropic' });

		expect(store.getChatError()).toBe('No key is stored for Anthropic yet. Open Settings → Configuration and add one.');
	});

	it('names the one settings field the owner still has to fill in', async () => {
		i18n.setLocale('de');
		await sendRefused({ error: 'x', code: 'llm_not_configured', may_configure: true, provider: 'Google Vertex AI', missing: ['gcp_project_id'] });

		expect(store.getChatError()).toBe('Für Google Vertex AI fehlt noch die GCP-Projekt-ID. Öffne Einstellungen → Konfiguration und trag sie ein.');
	});

	it('names two missing fields joined, in the page language', async () => {
		i18n.setLocale('en');
		await sendRefused({ error: 'x', code: 'llm_not_configured', may_configure: true, provider: 'OpenAI-compatible', missing: ['api_base_url', 'model_id'] });

		expect(store.getChatError()).toBe('OpenAI-compatible is missing the base URL and the model ID. Open Settings → Configuration and fill it in.');
	});

	it('takes the key sentence when the key is among what is missing', async () => {
		i18n.setLocale('de');
		await sendRefused({ error: 'x', code: 'llm_not_configured', may_configure: true, provider: 'Mistral', missing: ['key', 'model_id'] });

		expect(store.getChatError()).toBe('Für Mistral ist noch kein Schlüssel hinterlegt. Öffne Einstellungen → Konfiguration und füg einen hinzu.');
	});

	it('does not tell an owner answer without a provider to ask the owner', async () => {
		i18n.setLocale('de');
		await sendRefused({ error: 'x', code: 'llm_not_configured', may_configure: true, missing: ['key'] });

		expect(store.getChatError()).toBe(i18n.t('chat.error_invalid_request'));
	});

	it('keeps the general sentence for a field it has no name for', async () => {
		i18n.setLocale('de');
		await sendRefused({ error: 'x', code: 'llm_not_configured', may_configure: true, provider: 'Mistral', missing: ['region'] });

		expect(store.getChatError()).toBe(i18n.t('chat.error_invalid_request'));
	});

	it('tells a mandate to ask the owner, without a provider or a settings page', async () => {
		i18n.setLocale('de');
		await sendRefused({ error: 'x', code: 'llm_not_configured', may_configure: false });

		expect(store.getChatError()).toBe('Auf dieser Instanz ist noch kein KI-Anbieter eingerichtet. Das kann nur der Inhaber. Wende dich an den Inhaber.');
		const user = store.getMessages().find((m) => m.role === 'user' && m.content === 'hello');
		expect(user?.failed, 'kept, failed').toBe(true);
	});

	it('keeps the general sentence for any other 400, even one with the same fields', async () => {
		i18n.setLocale('de');
		await sendRefused({ error: 'Missing task' });
		expect(store.getChatError()).toBe(i18n.t('chat.error_invalid_request'));

		await sendRefused({ error: 'x', code: 'something_else', may_configure: false });
		expect(store.getChatError()).toBe(i18n.t('chat.error_invalid_request'));
	});
});
