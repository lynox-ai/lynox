import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendNoteOnce, trailingTurnNote, type TurnNote } from '../utils/active-runs.js';

// Drives a real turn through the chat store and ends its stream the way an
// aborted run's stream ends: without `done`. The server has written a note for
// the run ("Turn interrupted"), and the transcript ends on it. When the turn had
// already rendered something, the note never reached the live client; only a
// reload showed it.

type Store = typeof import('./chat.svelte.js');

/** A server-sent-events body the test feeds one event at a time. */
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

/** Lets the store's read loops consume what was enqueued. */
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

const INTERRUPTED = { role: 'assistant', content: '', note: { code: 'run_interrupted' } };
const USER = { role: 'user', content: 'write the essay' };

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

interface Server {
	/** `/runs/active`: no live run (the default) or the registry down. A live run never reaches
	 *  the branch under test — `took-over` returns before it — so it has no case here. */
	registry?: 'no-run' | 'unreachable';
	/** What `/threads/t1/messages` returns. */
	transcript: unknown[];
}

/** Starts a turn; returns the open `/run` stream and the turn's promise. */
async function startTurn(server: Server): Promise<{ run: ReturnType<typeof sseStream>; turn: Promise<void>; transcriptReads: () => number }> {
	const run = sseStream();
	let transcriptReads = 0;
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.endsWith('/sessions')) return json({ sessionId: 't1' });
		if (url.endsWith('/sessions/t1/run')) return new Response(run.body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		if (url.endsWith('/runs/active')) {
			if (server.registry === 'unreachable') return json({}, 503);
			return json({ runs: [] });
		}
		if (url.endsWith('/threads/t1/messages')) { transcriptReads++; return json({ messages: server.transcript }); }
		return json({}, 404);
	}));
	const turn = store.sendMessage('write the essay');
	await settle();
	return { run, turn, transcriptReads: () => transcriptReads };
}

/** The rows after the user's message: the turn's bubble and whatever follows it. */
function afterUser(): Array<{ role: string; content: string; note?: TurnNote; blocks?: unknown[]; toolCalls?: unknown[] }> {
	const all = store.getMessages() as Array<{ role: string; content: string; note?: TurnNote; blocks?: unknown[]; toolCalls?: unknown[] }>;
	const u = all.findIndex((m) => m.role === 'user');
	return all.slice(u + 1);
}

describe('a turn that rendered something and then lost its run shows the run\'s note', () => {
	it('after thinking only: the thinking stays and the note follows it', async () => {
		const { run, turn } = await startTurn({ transcript: [USER, INTERRUPTED] });
		run.send('thinking', { thinking: 'The user wants an essay about railways.', agent: 'lynox' });
		await settle();
		run.close();
		await turn; await settle();

		const rows = afterUser();
		expect(rows[0]?.blocks?.length).toBeGreaterThan(0);
		expect(rows[1]?.note?.code).toBe('run_interrupted');
		expect(rows).toHaveLength(2);
	});

	it('after streamed text: the text the user read is kept, not replaced by the transcript', async () => {
		// The server does not persist an answer the abort cut off: the transcript
		// holds the user message and the note, no text.
		const { run, turn } = await startTurn({ transcript: [USER, INTERRUPTED] });
		run.send('text', { text: 'Swiss railways began in 1847 with the Spanish-Brötli-Bahn.', agent: 'lynox' });
		await settle();
		run.close();
		await turn; await settle();

		const rows = afterUser();
		expect(rows[0]?.content).toBe('Swiss railways began in 1847 with the Spanish-Brötli-Bahn.');
		expect(rows[1]?.note?.code).toBe('run_interrupted');
	});

	it('after tool calls: the calls stay and the note follows them', async () => {
		const { run, turn } = await startTurn({
			transcript: [USER, { role: 'assistant', content: 'step1', toolCalls: [{ name: 'bash', status: 'done' }] }, INTERRUPTED],
		});
		run.send('tool_call', { name: 'bash', input: { command: 'echo step1' }, agent: 'lynox' });
		run.send('tool_result', { name: 'bash', result: 'step1', agent: 'lynox' });
		await settle();
		run.close();
		await turn; await settle();

		const rows = afterUser();
		expect(rows[0]?.toolCalls?.length).toBe(1);
		expect(rows[1]?.note?.code).toBe('run_interrupted');
	});
});

describe('nothing is added where the note is not this turn\'s, or not yet known', () => {
	it('registry unreachable: no note, and the transcript is not asked', async () => {
		// Without an answer from the registry the run may still be going; its note
		// does not exist yet, and an earlier one would be a false report.
		const { run, turn, transcriptReads } = await startTurn({ registry: 'unreachable', transcript: [USER, INTERRUPTED] });
		run.send('text', { text: 'partial', agent: 'lynox' });
		await settle();
		run.close();
		await turn; await settle();

		expect(afterUser().some((m) => m.note)).toBe(false);
		expect(transcriptReads()).toBe(0);
	});

	it('the transcript ends on an answer without a note: nothing is added', async () => {
		const { run, turn } = await startTurn({ transcript: [USER, { role: 'assistant', content: 'done' }] });
		run.send('text', { text: 'partial', agent: 'lynox' });
		await settle();
		run.close();
		await turn; await settle();

		expect(afterUser().some((m) => m.note)).toBe(false);
	});

	it('the note at the end belongs to an EARLIER turn: nothing is added', async () => {
		// The transcript holds no user message for this turn, so its trailing note
		// is about a turn before it.
		const { run, turn } = await startTurn({ transcript: [INTERRUPTED] });
		run.send('text', { text: 'partial', agent: 'lynox' });
		await settle();
		run.close();
		await turn; await settle();

		expect(afterUser().some((m) => m.note)).toBe(false);
	});
});

describe('the note is added once', () => {
	it('a second pass over the same turn does not add it again', () => {
		const rows: Array<{ role: string; content: string; note?: TurnNote }> = [
			{ role: 'user', content: 'q' },
			{ role: 'assistant', content: 'partial' },
		];
		const make = (n: TurnNote) => ({ role: 'assistant', content: '', note: n });
		expect(appendNoteOnce(rows, 1, { code: 'run_interrupted' }, make)).toBe(true);
		expect(appendNoteOnce(rows, 1, { code: 'run_interrupted' }, make)).toBe(false);
		expect(rows.filter((r) => r.note)).toHaveLength(1);
	});

	it('a reconcile after the note holds it once', async () => {
		const { run, turn } = await startTurn({ transcript: [USER, INTERRUPTED] });
		run.send('text', { text: 'partial', agent: 'lynox' });
		await settle();
		run.close();
		await turn; await settle();
		expect(afterUser().filter((m) => m.note)).toHaveLength(1);

		await store.reconcileThread();
		await settle();
		expect(afterUser().filter((m) => m.note)).toHaveLength(1);
	});
});

describe('trailingTurnNote', () => {
	it('reads the note off the last row, with its detail', () => {
		expect(trailingTurnNote({ messages: [USER, { role: 'assistant', content: '', note: { code: 'tool_loop_break', detail: 'bash' } }] }, 1))
			.toEqual({ code: 'tool_loop_break', detail: 'bash' });
	});

	it('refuses a body that is not the transcript shape', () => {
		expect(trailingTurnNote(null, 0)).toBeNull();
		expect(trailingTurnNote({ messages: 'no' }, 0)).toBeNull();
		expect(trailingTurnNote({ messages: [] }, 0)).toBeNull();
		expect(trailingTurnNote({ messages: [USER, { role: 'assistant', content: '', note: { code: '' } }] }, 1)).toBeNull();
	});
});
