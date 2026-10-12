import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Drives events through the real chat store: the delegation row (`spawn_agent`,
// labelled "Delegated") must not show a check mark while its children still run.
// The model's turn ends with `stop_reason: 'tool_use'` BEFORE the tool runs, so a
// `turn_end` that settled every running call painted ✓ over a delegation that had
// only just started.

type Store = typeof import('./chat.svelte.js');

/** A server-sent-events body the test feeds one event at a time. */
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

/** Lets the store's read loops consume what was enqueued. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

let store: Store;

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	vi.resetModules();
	store = await import('./chat.svelte.js');
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** A re-attached run with an open stream; returns the stream to feed. */
async function attachRun(): Promise<ReturnType<typeof sseStream>> {
	const stream = sseStream();
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/threads/t1')) return json({ thread: null });
		if (url.endsWith('/threads/t1/messages')) {
			return json({ messages: [{ role: 'user', content: 'research three vendors' }], activeRun: { runId: 'r1', status: 'running', lastPersistedSeq: 0 } });
		}
		if (url.includes('/runs/r1/stream')) return new Response(stream.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		return json({}, 404);
	}));
	await store.resumeThread('t1');
	await settle();
	return stream;
}

const usage = { input_tokens: 10, output_tokens: 5 };

/** The delegation's own row in the main agent's tool calls. */
function delegation(): { status?: string } | undefined {
	const msg = store.getMessages().at(-1) as { toolCalls?: { name: string; status?: string }[] } | undefined;
	return msg?.toolCalls?.find((tc) => tc.name === 'spawn_agent');
}

describe('delegation row: no check mark while sub-agents run', () => {
	it('stays running through the tool_use turn end and a child result, and is done only on its own result', async () => {
		const stream = await attachRun();

		stream.send('tool_call', { name: 'spawn_agent', input: { agents: [{ name: 'scout', task: 'find vendors' }] }, agent: 'lynox' }, 1);
		// The model stops in order to RUN the tool: nothing has finished yet.
		stream.send('turn_end', { stop_reason: 'tool_use', usage, agent: 'lynox' }, 2);
		stream.send('spawn', { spawnId: 's1', subAgents: [{ id: 's1:0', name: 'scout' }], agent: 'lynox' }, 3);
		// A child's own call and result, tagged with its origin, while it works.
		stream.send('tool_call', { name: 'web_research', input: { query: 'vendors' }, agent: 'scout', subAgent: 'scout', subAgentId: 's1:0' }, 4);
		stream.send('tool_result', { name: 'web_research', result: 'three found', agent: 'scout', subAgent: 'scout', subAgentId: 's1:0' }, 5);
		await settle();

		expect(delegation()?.status).toBe('running');

		stream.send('spawn_child_done', { spawnId: 's1', subAgent: 'scout', subAgentId: 's1:0', ok: true, elapsedS: 3, costUsd: 0.01, agent: 'lynox' }, 6);
		stream.send('tool_result', { name: 'spawn_agent', result: '## scout\nthree found', agent: 'lynox' }, 7);
		await settle();

		expect(delegation()?.status).toBe('done');
		stream.close();
	});

	// The witness for the assertion above: the same `turn_end` on a reason that
	// does end the turn settles a call left running. Without it, "stays running"
	// could also mean the store never settles anything on `turn_end`.
	it('is settled by a turn end that really ends the turn', async () => {
		const stream = await attachRun();

		stream.send('tool_call', { name: 'spawn_agent', input: { agents: [{ name: 'scout', task: 'find vendors' }] }, agent: 'lynox' }, 1);
		stream.send('turn_end', { stop_reason: 'end_turn', usage, agent: 'lynox' }, 2);
		await settle();

		expect(delegation()?.status).toBe('done');
		stream.close();
	});
});
