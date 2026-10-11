import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Requests the user makes from the chat (answer a prompt, stop a run, dismiss a prompt) never
// reject out of the store, and the ones whose loss the user would not notice are reported.

type Store = typeof import('./chat.svelte.js');

const toasts: Array<{ message: string; type: string }> = [];
vi.mock('./toast.svelte.js', () => ({
	addToast: (message: string, type: string) => { toasts.push({ message, type }); return 1; },
}));

function sseStream(): { body: ReadableStream<Uint8Array>; send: (type: string, data: unknown) => void; close: () => void } {
	const enc = new TextEncoder();
	let ctrl!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
	return { body, send: (type, data) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)), close: () => ctrl.close() };
}
const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;
let calls: string[];

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	store = await import('./chat.svelte.js');
	toasts.length = 0;
	calls = [];
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A session whose run stream stays open until `close`, with every other route answered by `route`. */
function openRun(route: (url: string) => Response | Promise<Response>): { send: (type: string, data: unknown) => void; close: () => void } {
	const stream = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/run')) return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		return route(url);
	}));
	return stream;
}

describe('a prompt answer that does not arrive', () => {
	it('is reported after the retry, and the call resolves', async () => {
		openRun((url) => { if (url.endsWith('/reply')) throw new TypeError('Failed to fetch'); return json({}); });
		void store.sendMessage('go');
		await settle();
		await expect(store.replyPermission('yes')).resolves.toBeUndefined();
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
		expect(calls.filter((u) => u.endsWith('/reply'))).toHaveLength(2);
	});

	it('says nothing when it arrives, or when the server gives a final answer such as 400', async () => {
		openRun(() => json({}));
		void store.sendMessage('go');
		await settle();
		await store.replyPermission('yes');
		expect(toasts).toEqual([]);

		vi.resetModules();
		store = await import('./chat.svelte.js');
		openRun((url) => (url.endsWith('/reply') ? json({ error: 'bad answer' }, 400) : json({})));
		void store.sendMessage('go');
		await settle();
		await store.replyPermission('yes');
		expect(toasts).toEqual([]);
	});
});

describe('a tabbed prompt answer that does not arrive', () => {
	it('is reported after the retry, and the call resolves', async () => {
		const run = openRun((url) => { if (url.endsWith('/reply-tabs')) throw new TypeError('Failed to fetch'); return json({}); });
		void store.sendMessage('go');
		await settle();
		run.send('prompt_tabs', { promptId: 'p3', questions: [{ question: 'Which?', options: ['a', 'b'] }] });
		await settle();
		await expect(store.replyPermissionTabs(['a'])).resolves.toBeUndefined();
		expect(calls.filter((u) => u.endsWith('/reply-tabs'))).toHaveLength(2);
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
	});
});

describe('a stop whose request fails', () => {
	it('is reported, leaves the run streaming, and still counts as the user stopping it', async () => {
		const run = openRun((url) => {
			if (url.endsWith('/abort')) throw new TypeError('Failed to fetch');
			if (url.endsWith('/runs/active')) return json({ runs: [] });
			return json({ messages: [], activeRun: null });
		});
		void store.sendMessage('go');
		await settle();
		expect(store.getIsStreaming()).toBe(true);

		await expect(store.abortRun()).resolves.toBe(false);
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
		expect(store.getIsStreaming()).toBe(true);

		// The request may have arrived with only its answer lost. The stream then ends without a
		// terminal event and is read as the user's stop: the server is not probed, so the turn is
		// never marked unsent and sent again.
		run.close();
		await settle();
		expect(calls.some((u) => u.endsWith('/runs/active'))).toBe(false);
	});
});

describe('dismissing a prompt the server refuses or the user leaves', () => {
	it('a 5xx answer counts as not arrived: the card comes back and the user is told', async () => {
		const run = openRun((url) => (url.endsWith('/secret-saved') ? json({}, 503) : json({})));
		void store.sendMessage('go');
		await settle();
		run.send('secret_prompt', { name: 'API_KEY', prompt: 'key?', promptId: 'p1' });
		await settle();
		await store.cancelSecret();
		expect(store.getPendingSecretPrompt()?.promptId).toBe('p1');
		expect(toasts).toEqual([expect.objectContaining({ type: 'error' })]);
	});

	it('does not bring the card back into another thread the user moved to meanwhile', async () => {
		let failCancel!: (e: unknown) => void;
		const run = openRun((url) => (url.endsWith('/secret-saved')
			? new Promise<Response>((_, reject) => { failCancel = reject; })
			: json({})));
		void store.sendMessage('go');
		await settle();
		run.send('secret_prompt', { name: 'API_KEY', prompt: 'key?', promptId: 'p1' });
		await settle();
		const cancel = store.cancelSecret();
		await settle();
		store.newChat();
		failCancel(new TypeError('Failed to fetch'));
		await cancel;
		expect(store.getPendingSecretPrompt()).toBeNull();
	});
});

describe('dismissing a prompt with no network', () => {
	it('resolves for a secret and for a mail connection, brings each card back and says so', async () => {
		const run = openRun((url) => {
			if (url.endsWith('/secret-saved') || url.endsWith('/mail-connected')) throw new TypeError('Failed to fetch');
			return json({});
		});
		void store.sendMessage('go');
		await settle();
		run.send('secret_prompt', { name: 'API_KEY', prompt: 'key?', promptId: 'p1' });
		run.send('mail_connect_prompt', { promptId: 'p2', id: 'a1', displayName: 'Me', address: 'me@example.com', preset: 'custom' });
		await settle();
		expect(store.getPendingSecretPrompt()).not.toBeNull();
		expect(store.getPendingMailConnect()).not.toBeNull();

		await expect(store.cancelSecret()).resolves.toBeUndefined();
		await expect(store.cancelMailConnect()).resolves.toBeUndefined();
		expect(calls.filter((u) => u.endsWith('/secret-saved') || u.endsWith('/mail-connected'))).toHaveLength(2);
		expect(store.getPendingSecretPrompt()?.promptId).toBe('p1');
		expect(store.getPendingMailConnect()?.promptId).toBe('p2');
		expect(toasts.filter((t) => t.type === 'error')).toHaveLength(2);
	});
});

describe('a new question that arrives while an answer is being saved', () => {
	it('keeps its card for a secret and for a mail connection', async () => {
		let putDone!: (r: Response) => void;
		let accountDone!: (r: Response) => void;
		const run = openRun((url) => {
			if (url.includes('/secrets/')) return new Promise<Response>((r) => { putDone = r; });
			if (url.endsWith('/mail/accounts')) return new Promise<Response>((r) => { accountDone = r; });
			return json({});
		});
		void store.sendMessage('go');
		await settle();
		run.send('secret_prompt', { name: 'API_KEY', prompt: 'key?', promptId: 'p1' });
		await settle();
		const saving = store.submitSecret('API_KEY', 'value');
		await settle();
		run.send('secret_prompt', { name: 'API_KEY', prompt: 'key?', promptId: 'p2' });
		await settle();
		putDone(json({}));
		await expect(saving).resolves.toBe('saved');
		expect(store.getPendingSecretPrompt()?.promptId).toBe('p2');

		run.send('mail_connect_prompt', { promptId: 'm1', id: 'a1', displayName: 'Me', address: 'me@example.com', preset: 'custom' });
		await settle();
		const connecting = store.submitMailConnect('pw');
		await settle();
		run.send('mail_connect_prompt', { promptId: 'm2', id: 'a1', displayName: 'Me', address: 'me@example.com', preset: 'custom' });
		await settle();
		accountDone(json({}));
		await expect(connecting).resolves.toEqual({ ok: true });
		expect(store.getPendingMailConnect()?.promptId).toBe('m2');
	});

	it('keeps it for a secret whose vault write failed', async () => {
		let putFail!: (e: unknown) => void;
		const run = openRun((url) => (url.includes('/secrets/') ? new Promise<Response>((_, reject) => { putFail = reject; }) : json({})));
		void store.sendMessage('go');
		await settle();
		run.send('secret_prompt', { name: 'API_KEY', prompt: 'key?', promptId: 'p1' });
		await settle();
		const saving = store.submitSecret('API_KEY', 'value');
		await settle();
		run.send('secret_prompt', { name: 'API_KEY', prompt: 'key?', promptId: 'p2' });
		await settle();
		putFail(new TypeError('Failed to fetch'));
		await expect(saving).resolves.toBe('vault_error');
		expect(store.getPendingSecretPrompt()?.promptId).toBe('p2');
	});

	it('control: without a new question the saved card is cleared', async () => {
		const run = openRun(() => json({}));
		void store.sendMessage('go');
		await settle();
		run.send('secret_prompt', { name: 'API_KEY', prompt: 'key?', promptId: 'p1' });
		run.send('mail_connect_prompt', { promptId: 'm1', id: 'a1', displayName: 'Me', address: 'me@example.com', preset: 'custom' });
		await settle();
		await expect(store.submitSecret('API_KEY', 'value')).resolves.toBe('saved');
		await expect(store.submitMailConnect('pw')).resolves.toEqual({ ok: true });
		expect(store.getPendingSecretPrompt()).toBeNull();
		expect(store.getPendingMailConnect()).toBeNull();
	});
});
