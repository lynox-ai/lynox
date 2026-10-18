import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldRenderArtifactCard } from '../utils/artifact-inline.js';

// Drives a real turn through the chat store: an `artifact_save` call whose
// `tool_result` event never reaches the browser, then `done`. The run's end
// sweeps the call from `running` to `done`; the card must not read that as a
// finished save, because a refused one (the eviction placeholder as content)
// looks exactly the same in this tab.

type Store = typeof import('./chat.svelte.js');
type Call = { name: string; status: 'running' | 'done' | 'error'; result?: string };

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

const DOC = '<h1>Pitch</h1><p>Three budget options.</p>';

let store: Store;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	store = await import('./chat.svelte.js');
});

afterEach(() => {
	store.newChat();
	vi.unstubAllGlobals();
});

/** Runs one turn with an `artifact_save` call, the given result events, then `done`; returns the call. */
async function saveTurn(result: Record<string, unknown> | null): Promise<Call> {
	const run = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/threads/t1')) return json({ thread: null });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/threads/t1/messages')) return json({ messages: [] });
		return json({}, 404);
	}));
	const turn = store.sendMessage('write the pitch');
	await settle();
	run.send('tool_call', { name: 'artifact_save', input: { title: 'Pitch', content: DOC }, agent: 'lynox' });
	await settle();
	if (result) run.send('tool_result', { name: 'artifact_save', agent: 'lynox', ...result });
	run.send('done', { agent: 'lynox' });
	run.close();
	await turn; await settle();
	const calls = (store.getMessages() as Array<{ role: string; toolCalls?: Call[] }>)
		.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name === 'artifact_save');
	expect(calls).toHaveLength(1);
	return calls[0]!;
}

describe('an artifact_save card after the run ends', () => {
	it('is not drawn when the call\'s result never arrived and the end of the run swept it to done', async () => {
		const call = await saveTurn(null);
		expect(call.status).toBe('done');
		expect(call.result).toBeUndefined();
		expect(shouldRenderArtifactCard(call, DOC, [])).toBe(false);
	});

	it('is drawn when the save\'s result arrived', async () => {
		const call = await saveTurn({ result: 'Saved artifact "Pitch" (id: ab12cd34, v1).' });
		expect(call.status).toBe('done');
		expect(shouldRenderArtifactCard(call, DOC, [])).toBe(true);
	});

	it('is not drawn when the result arrived as a refusal', async () => {
		const call = await saveTurn({ result: 'refused', isError: true });
		expect(call.status).toBe('error');
		expect(shouldRenderArtifactCard(call, DOC, [])).toBe(false);
	});
});
