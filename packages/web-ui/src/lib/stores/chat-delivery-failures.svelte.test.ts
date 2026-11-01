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

describe('an answer that arrives at a closed question', () => {
	type Route = 'reply' | 'reply-tabs';
	async function answerWith(route: Route, status: number, body: unknown): Promise<void> {
		const run = openRun((url) => (url.endsWith(`/${route}`) ? json(body, status) : json({})));
		void store.sendMessage('go');
		await settle();
		if (route === 'reply') {
			run.send('prompt', { promptId: 'p1', question: 'Which?' });
			await settle();
			await store.replyPermission('a');
		} else {
			run.send('prompt_tabs', { promptId: 'p3', questions: [{ question: 'Which?', options: ['a', 'b'] }] });
			await settle();
			await store.replyPermissionTabs(['a']);
		}
	}
	const say = async (key: string): Promise<string> => (await import('../i18n.svelte.js')).t(key);

	for (const route of ['reply', 'reply-tabs'] as const) {
		it(`${route}: an expired question says the answer was not used`, async () => {
			await answerWith(route, 410, { error: 'Prompt expired' });
			expect(store.getChatError()).toBe(await say('chat.prompt_expired'));
			expect(toasts).toEqual([]);
		});

		it(`${route}: a question the restart closed says to start the task again`, async () => {
			await answerWith(route, 410, { error: 'Prompt closed: the engine restarted', code: 'process_restarted' });
			expect(store.getChatError()).toBe(await say('chat.prompt_closed_restart'));
			expect(toasts).toEqual([]);
		});

		it(`${route}: a stale (404) or refused (409) answer says nothing`, async () => {
			await answerWith(route, 404, { error: 'No pending prompt' });
			expect(store.getChatError()).toBeNull();
			vi.resetModules();
			store = await import('./chat.svelte.js');
			await answerWith(route, 409, { error: 'Prompt is a different kind of question' });
			expect(store.getChatError()).toBeNull();
			expect(toasts).toEqual([]);
		});
	}

	it('a 410 whose body is not JSON says the answer was not used', async () => {
		const run = openRun((url) => (url.endsWith('/reply') ? new Response('gone', { status: 410 }) : json({})));
		void store.sendMessage('go');
		await settle();
		run.send('prompt', { promptId: 'p1', question: 'Which?' });
		await settle();
		await store.replyPermission('a');
		expect(store.getChatError()).toBe(await say('chat.prompt_expired'));
	});

	it('says nothing in another chat when the user left the one that asked before the 410 came', async () => {
		let answer!: (r: Response) => void;
		const run = openRun((url) => (url.endsWith('/reply') ? new Promise<Response>((r) => { answer = r; }) : json({})));
		void store.sendMessage('go');
		await settle();
		run.send('prompt', { promptId: 'p1', question: 'Which?' });
		await settle();
		const replying = store.replyPermission('a');
		await settle();
		store.newChat();
		answer(json({ error: 'Prompt expired' }, 410));
		await replying;
		expect(store.getChatError()).toBeNull();
	});

	it('does not put the sentence over an error already standing, and leaves that error up', async () => {
		const run = openRun((url) => (url.endsWith('/reply') ? json({ error: 'Prompt expired' }, 410) : json({})));
		void store.sendMessage('go');
		await settle();
		run.send('prompt', { promptId: 'p1', question: 'Which?' });
		await settle();
		// The run fails with an upstream error while its question card is still open.
		run.send('error', { error: 'Mistral 401 unauthorized' });
		await settle();
		const standing = store.getChatError();
		expect(standing).not.toBeNull();
		expect(standing).not.toBe(await say('chat.prompt_expired'));
		await store.replyPermission('a');
		expect(store.getChatError()).toBe(standing);
	});

	it('the sentence stands until the next message is sent, also when that message waits in the queue', async () => {
		await answerWith('reply', 410, { error: 'Prompt expired' });
		await settle();
		expect(store.getChatError()).toBe(await say('chat.prompt_expired'));
		// The run that asked is still streaming, so the message is queued.
		void store.sendMessage('again');
		await settle();
		expect(store.getChatError()).toBeNull();
	});

	it('a message queued while another error stands leaves that error up', async () => {
		const run = openRun(() => json({}));
		void store.sendMessage('go');
		await settle();
		// The provider's error arrives as text in a run that goes on: the run is still streaming.
		run.send('text', { text: '429 {"type":"error","error":{"message":"rate limited"}}' });
		await settle();
		const standing = store.getChatError();
		expect(standing).not.toBeNull();
		void store.sendMessage('again');
		await settle();
		expect(store.getMessages().at(-1)).toMatchObject({ role: 'user', content: 'again', queued: true });
		expect(store.getChatError()).toBe(standing);
	});

	it('a message queued after another error replaced the sentence leaves that error up', async () => {
		const run = openRun((url) => (url.endsWith('/reply') ? json({ error: 'Prompt expired' }, 410) : json({})));
		void store.sendMessage('go');
		await settle();
		run.send('prompt', { promptId: 'p1', question: 'Which?' });
		await settle();
		await store.replyPermission('a');
		expect(store.getChatError()).toBe(await say('chat.prompt_expired'));
		// The run goes on, and the provider's error takes the sentence's place.
		run.send('text', { text: '429 {"type":"error","error":{"message":"rate limited"}}' });
		await settle();
		const standing = store.getChatError();
		expect(standing).not.toBeNull();
		expect(standing).not.toBe(await say('chat.prompt_expired'));
		void store.sendMessage('again');
		await settle();
		expect(store.getMessages().at(-1)).toMatchObject({ role: 'user', content: 'again', queued: true });
		expect(store.getChatError()).toBe(standing);
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

	it('does not keep a card shown again for the same question, as a resume does', async () => {
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
		run.send('secret_prompt', { name: 'API_KEY', prompt: 'key?', promptId: 'p1' });
		await settle();
		putDone(json({}));
		await expect(saving).resolves.toBe('saved');
		expect(store.getPendingSecretPrompt()).toBeNull();

		run.send('mail_connect_prompt', { promptId: 'm1', id: 'a1', displayName: 'Me', address: 'me@example.com', preset: 'custom' });
		await settle();
		const connecting = store.submitMailConnect('pw');
		await settle();
		run.send('mail_connect_prompt', { promptId: 'm1', id: 'a1', displayName: 'Me', address: 'me@example.com', preset: 'custom' });
		await settle();
		accountDone(json({}));
		await expect(connecting).resolves.toEqual({ ok: true });
		expect(store.getPendingMailConnect()).toBeNull();
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

describe('why a question was closed, and the lost answer as a draft (UX-064, UX-068)', () => {
	const say = async (key: string): Promise<string> => (await import('../i18n.svelte.js')).t(key);
	/** Answers 'my answer' (or `answer`) to a question the server reports closed with `code`, as `viewer`. */
	async function closedWith(code: string, opts: { viewer?: 'owner' | 'mandate'; field?: string; answer?: string; tabs?: boolean; options?: string[] } = {}): Promise<{ field: string; asked: number }> {
		let field = opts.field ?? '';
		let asked = 0;
		store.registerComposerDraft((text) => { asked++; if (field.trim() !== '') return false; field = text; return true; });
		const route = opts.tabs === true ? 'reply-tabs' : 'reply';
		const run = openRun((url) => {
			if (url.endsWith('/config')) return json(opts.viewer !== undefined ? { viewer: opts.viewer } : {});
			return url.endsWith(`/${route}`) ? json({ error: 'Prompt closed', code }, 410) : json({});
		});
		void store.sendMessage('go');
		await settle();
		if (opts.tabs === true) {
			run.send('prompt_tabs', { promptId: 'p3', questions: [{ question: 'Which?', options: ['a', 'b'] }] });
			await settle();
			await store.replyPermissionTabs(['my answer']);
		} else {
			run.send('prompt', { promptId: 'p1', question: 'Which?', ...(opts.options !== undefined ? { options: opts.options } : {}) });
			await settle();
			await store.replyPermission(opts.answer ?? 'my answer');
		}
		return { field, asked };
	}

	// Each code: its sentence, and whether the answer comes back (ux U-113).
	const owner: Array<[code: string, key: string, draft: boolean]> = [
		['process_restarted', 'chat.prompt_closed_restart', true],
		['timed_out', 'chat.prompt_closed.timed_out', true],
		['run_stopped', 'chat.prompt_closed.run_stopped', true],
		['run_taken_over', 'chat.prompt_closed.run_taken_over', true],
		['thread_deleted', 'chat.prompt_closed.thread_deleted', false],
		['mandate_ended', 'chat.prompt_closed.mandate_ended.owner', true],
		['plan_paused', 'chat.prompt_closed.plan_paused.owner', false],
		['plan_taken_over', 'chat.prompt_closed.plan_taken_over.owner', true],
		['plan_ended', 'chat.prompt_closed.plan_ended', true],
		['superseded', 'chat.prompt_closed.superseded', false],
	];
	for (const [code, key, draft] of owner) {
		it(`${code}: says why, and ${draft ? 'puts the answer back into the empty field and says so' : 'leaves the field alone'}`, async () => {
			const { field } = await closedWith(code, { viewer: 'owner' });
			const sentence = await say(key);
			expect(store.getChatError()).toBe(draft ? sentence + (await say('chat.prompt_closed.draft')) : sentence);
			expect(field).toBe(draft ? 'my answer' : '');
		});
	}

	it('a helper whose access ended is sent to the owner, without a draft', async () => {
		const { field, asked } = await closedWith('mandate_ended', { viewer: 'mandate' });
		expect(store.getChatError()).toBe(await say('chat.prompt_closed.mandate_ended.mandate'));
		expect(field).toBe('');
		expect(asked).toBe(0);
	});

	it('a helper whose plan was paused is sent to the owner, without a draft', async () => {
		const { field } = await closedWith('plan_paused', { viewer: 'mandate' });
		expect(store.getChatError()).toBe(await say('chat.prompt_closed.plan_paused.mandate'));
		expect(field).toBe('');
	});

	it('a helper whose plan the owner took over is told so and sent to the owner, without a draft', async () => {
		const { field, asked } = await closedWith('plan_taken_over', { viewer: 'mandate' });
		expect(store.getChatError()).toBe(await say('chat.prompt_closed.plan_taken_over.mandate'));
		expect(field).toBe('');
		expect(asked).toBe(0);
	});

	it('a consent card\'s answer is no draft: typed into the chat it would approve nothing', async () => {
		for (const options of [['Allow', 'Deny'], ['Run on balanced', 'Cancel']]) {
			vi.resetModules();
			store = await import('./chat.svelte.js');
			const { field, asked } = await closedWith('timed_out', { answer: 'y', options });
			expect(asked, options.join('/')).toBe(0);
			expect(field).toBe('');
			expect(store.getChatError()).toBe(await say('chat.prompt_closed.timed_out'));
		}
	});

	it('an option the user picked comes back as that option', async () => {
		const { field } = await closedWith('run_stopped', { answer: 'lynox-pro', options: ['lynox', 'lynox-pro'] });
		expect(field).toBe('lynox-pro');
	});

	it('a field with text in it keeps it, and the sentence does not claim the answer is back', async () => {
		const { field, asked } = await closedWith('timed_out', { field: 'half a thought' });
		expect(asked).toBe(1);
		expect(field).toBe('half a thought');
		expect(store.getChatError()).toBe(await say('chat.prompt_closed.timed_out'));
	});

	it('several answers to a tabs question are no draft', async () => {
		const { field, asked } = await closedWith('timed_out', { tabs: true });
		expect(asked).toBe(0);
		expect(field).toBe('');
		expect(store.getChatError()).toBe(await say('chat.prompt_closed.timed_out'));
	});

	it('a skipped question has no answer to give back', async () => {
		const { field, asked } = await closedWith('timed_out', { answer: '__dismissed__' });
		expect(asked).toBe(0);
		expect(field).toBe('');
		expect(store.getChatError()).toBe(await say('chat.prompt_closed.timed_out'));
	});

	it('a multi-select answer comes back as the chosen labels', async () => {
		const { field } = await closedWith('run_stopped', { answer: JSON.stringify(['lynox', 'lynox-pro']) });
		expect(field).toBe('lynox, lynox-pro');
	});

	it('an unknown code reads as no reason given', async () => {
		const { field } = await closedWith('something_new');
		expect(store.getChatError()).toBe((await say('chat.prompt_expired')) + (await say('chat.prompt_closed.draft')));
		expect(field).toBe('my answer');
	});
});
