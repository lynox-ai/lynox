// Runs in the browser-compile project (vitest.config.ts): Svelte state behaves as in the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ux U-150: a helper's conversation title that reads as carrying a key is refused by the server
// (422 `mandate_key_input`). The old title comes back and the toast says why, so the helper does not
// retry the same title; any other failure keeps the general sentence.

const toasts: string[] = [];
vi.mock('./toast.svelte.js', () => ({ addToast: (msg: string) => { toasts.push(msg); return 1; } }));

const json = (body: unknown, status: number): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let store: typeof import('./threads.svelte.js');
let t: (key: string) => string;

beforeEach(async () => {
	toasts.length = 0;
	vi.resetModules();
	store = await import('./threads.svelte.js');
	({ t } = await import('../i18n.svelte.js'));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('a helper\'s title refused as carrying a key', () => {
	it('says the sentence of its own', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'refused', code: 'mandate_key_input' }, 422)));
		await store.renameThread('t1', 'irrelevant');
		expect(toasts).toEqual([t('chat.mandate_key_input_other')]);
	});

	it('CONTROL: another refusal keeps the general sentence', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'nope', code: 'other' }, 422)));
		await store.renameThread('t1', 'irrelevant');
		expect(toasts).toEqual([t('threads.error_rename')]);
	});
});
