import { describe, it, expect } from 'vitest';

import {
	recordToolCall,
	recordToolResult,
	recordSpawn,
	applySpawnProgress,
	applyChildDone,
	parseAnnouncedSubAgents,
	batchTotals,
	foldToolRows,
	worstStatus,
	SPAWN_EVENT,
	SPAWN_PROGRESS_EVENT,
	SPAWN_CHILD_DONE_EVENT,
	type AttributionState,
	type ToolCallInfo,
} from './chat-attribution.js';

/**
 * Sub-agent attribution: whose work is this?
 *
 * The engine has always said so — `subAgent` rides on every event a child
 * forwards — but the chat store never read it, so a delegated agent's tool
 * calls were pushed into the same list as the main agent's. That makes the
 * transcript WRONG, not merely thin, which is why most of these tests assert an
 * ABSENCE from `toolCalls` rather than a presence somewhere.
 *
 * The functions under test own the routing decision (parent list vs child card)
 * end to end. That placement is deliberate: a helper that only answers "is this
 * a child event?" can be perfectly green while the caller ignores the answer.
 */

function batch(spawnId: string, children: Array<{ id: string; name: string; role?: string; model?: string }>) {
	return { spawnId, subAgents: children };
}

/** A state with one two-child delegation already registered. */
function withDelegation(): AttributionState {
	const state: AttributionState = {};
	recordSpawn(state, batch('s1', [
		{ id: 's1:0', name: 'researcher', role: 'researcher', model: 'claude-haiku-4-5' },
		{ id: 's1:1', name: 'writer', model: 'mistral-medium-2604' },
	]), 1000);
	return state;
}

describe('parseAnnouncedSubAgents', () => {
	it('drops entries without a usable id or name', () => {
		expect(parseAnnouncedSubAgents([
			{ id: 's:0', name: 'ok' },
			{ id: '', name: 'no id' },
			{ id: 's:2' },
			{ name: 'no id at all' },
			'not an object',
			null,
		])).toEqual([{ id: 's:0', name: 'ok', role: undefined, model: undefined }]);
	});

	it('returns an empty list for a malformed payload', () => {
		expect(parseAnnouncedSubAgents(undefined)).toEqual([]);
		expect(parseAnnouncedSubAgents('nope')).toEqual([]);
		expect(parseAnnouncedSubAgents({})).toEqual([]);
	});

	it('caps name and model length — both come from outside the client', () => {
		// The name is model-chosen; the model id can come from the operator's
		// `model_profiles`. Svelte escapes them, but a 4 kB "name" still wrecks
		// the layout of a panel that is one line per child.
		const [child] = parseAnnouncedSubAgents([
			{ id: 's:0', name: 'n'.repeat(500), role: 'r'.repeat(500), model: 'm'.repeat(500) },
		]);
		expect(child!.name).toHaveLength(64);
		expect(child!.role).toHaveLength(32);
		expect(child!.model).toHaveLength(64);
	});
});

describe('recordSpawn', () => {
	it('registers the batch, its children, and a block where it happened', () => {
		const state: AttributionState = { blocks: [{ type: 'text', text: 'Ich delegiere das.' }] };
		expect(recordSpawn(state, batch('s1', [{ id: 's1:0', name: 'scout' }]), 1000)).toBe(true);

		expect(state.spawns!['s1']!.childIds).toEqual(['s1:0']);
		expect(state.subAgents!['s1:0']).toMatchObject({ name: 'scout', status: 'running', toolCalls: [] });
		// Chronological: the panel renders after the text that preceded it, not
		// pinned to whichever tool row happened to come last.
		expect(state.blocks).toEqual([
			{ type: 'text', text: 'Ich delegiere das.' },
			{ type: 'spawn', spawnId: 's1' },
		]);
	});

	it('keeps two concurrent batches apart', () => {
		const state: AttributionState = {};
		recordSpawn(state, batch('s1', [{ id: 's1:0', name: 'a' }]), 1000);
		recordSpawn(state, batch('s2', [{ id: 's2:0', name: 'b' }]), 1100);

		// The old model held ONE spawn object per message, so the second batch
		// silently replaced the first — and the agent loop runs several
		// `spawn_agent` calls concurrently as a matter of course.
		expect(Object.keys(state.spawns!)).toEqual(['s1', 's2']);
		expect(state.blocks).toEqual([
			{ type: 'spawn', spawnId: 's1' },
			{ type: 'spawn', spawnId: 's2' },
		]);
	});

	it('is idempotent on a replayed frame', () => {
		const state: AttributionState = {};
		recordSpawn(state, batch('s1', [{ id: 's1:0', name: 'a' }]), 1000);
		recordSpawn(state, batch('s1', [{ id: 's1:0', name: 'a' }]), 1000);
		// The resumable stream replays by seq after a reconnect; a second panel
		// for the same delegation would be a visible duplicate.
		expect(state.blocks).toHaveLength(1);
	});

	it('refuses a payload it cannot render', () => {
		const state: AttributionState = {};
		expect(recordSpawn(state, { spawnId: 's1', subAgents: [] }, 1000)).toBe(false);
		expect(recordSpawn(state, { subAgents: [{ id: 'x', name: 'y' }] }, 1000)).toBe(false);
		expect(state.blocks).toBeUndefined();
	});
});

describe('recordToolCall', () => {
	it('keeps a child call OUT of the main agent list', () => {
		const state = withDelegation();
		const where = recordToolCall(state, { name: 'read_file', input: { path: 'a' }, subAgent: 'researcher', subAgentId: 's1:0' });

		expect(where).toBe('child');
		// The defect, stated as an absence: this is where it used to land.
		expect(state.toolCalls ?? []).toEqual([]);
		expect(state.subAgents!['s1:0']!.toolCalls).toEqual([
			{ name: 'read_file', input: { path: 'a' }, status: 'running' },
		]);
		// And it must not push a main-agent tool block either — that block is
		// what the transcript renders as the main agent doing the work.
		expect((state.blocks ?? []).some((b) => b.type === 'tool_call')).toBe(false);
	});

	it('files each child on its own card, even mid-delegation', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'read_file', input: {}, subAgentId: 's1:0' });
		recordToolCall(state, { name: 'web_research', input: {}, subAgentId: 's1:1' });

		expect(state.subAgents!['s1:0']!.toolCalls.map((c) => c.name)).toEqual(['read_file']);
		expect(state.subAgents!['s1:1']!.toolCalls.map((c) => c.name)).toEqual(['web_research']);
	});

	it('drops an event for a child it has no record of', () => {
		const state = withDelegation();
		const where = recordToolCall(state, { name: 'bash', input: {}, subAgent: 'ghost', subAgentId: 's9:0' });

		expect(where).toBe('dropped');
		// A lost `spawn` frame must not turn a sub-agent's `bash` into the main
		// agent's `bash`. Invisible is the correct failure direction here.
		expect(state.toolCalls ?? []).toEqual([]);
	});

	it('still records the main agent normally', () => {
		const state: AttributionState = { blocks: [{ type: 'text', text: 'Moment.' }] };
		expect(recordToolCall(state, { name: 'read_file', input: { path: 'x' } })).toBe('parent');

		expect(state.toolCalls).toEqual([{ name: 'read_file', input: { path: 'x' }, status: 'running' }]);
		expect(state.blocks![1]).toEqual({ type: 'tool_call', index: 0 });
	});

	it('reports the completed text block so auto-speak can start', () => {
		const state: AttributionState = { blocks: [{ type: 'text', text: 'Ich schaue nach.' }] };
		const seen: Array<[string, number]> = [];
		recordToolCall(state, { name: 'read_file', input: {} }, (text, i) => seen.push([text, i]));
		expect(seen).toEqual([['Ich schaue nach.', 0]]);
	});

	it('dedups a repeated running call from the main agent', () => {
		const state: AttributionState = {};
		recordToolCall(state, { name: 'read_file', input: { path: 'x' } });
		recordToolCall(state, { name: 'read_file', input: { path: 'x' } });
		expect(state.toolCalls).toHaveLength(1);
	});

	it('dedups a repeated running call from a CHILD too', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'read_file', input: { path: 'x' }, subAgentId: 's1:0' });
		recordToolCall(state, { name: 'read_file', input: { path: 'x' }, subAgentId: 's1:0' });
		// A re-attach replays frames from the last applied seq. Without the guard
		// the duplicate row sits at "running" forever, because the incoming
		// tool_result closes the FIRST match.
		expect(state.subAgents!['s1:0']!.toolCalls).toHaveLength(1);
		recordToolResult(state, { name: 'read_file', result: 'ok', subAgentId: 's1:0' });
		expect(state.subAgents!['s1:0']!.toolCalls.every((c) => c.status === 'done')).toBe(true);
	});

	it('does NOT dedup a same-named call with different input', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'read_file', input: { path: 'a' }, subAgentId: 's1:0' });
		recordToolCall(state, { name: 'read_file', input: { path: 'b' }, subAgentId: 's1:0' });
		// Reading two files is two calls. Without the input comparison the dedup
		// would swallow the second and the child's work would under-report.
		expect(state.subAgents!['s1:0']!.toolCalls.map((c) => c.input)).toEqual([{ path: 'a' }, { path: 'b' }]);
	});

	it('does NOT dedup two DIFFERENT tools that happen to share an input', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'read_file', input: {}, subAgentId: 's1:0' });
		recordToolCall(state, { name: 'list_dir', input: {}, subAgentId: 's1:0' });
		// `{}` is a common input, so without the name comparison the dedup
		// swallows the second call and the child under-reports its work.
		expect(state.subAgents!['s1:0']!.toolCalls.map((c) => c.name)).toEqual(['read_file', 'list_dir']);
	});

	it('does NOT dedup a repeat of a call that already CLOSED', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'read_file', input: { path: 'a' }, subAgentId: 's1:0' });
		recordToolResult(state, { name: 'read_file', result: 'first', subAgentId: 's1:0' });
		recordToolCall(state, { name: 'read_file', input: { path: 'a' }, subAgentId: 's1:0' });
		// An agent legitimately re-reads the same file later in the turn. Only a
		// STILL-RUNNING duplicate is a replayed frame; dropping the `status` check
		// would hide the second read.
		expect(state.subAgents!['s1:0']!.toolCalls).toHaveLength(2);
	});

	it('does NOT dedup the main agent\'s same-named call with different input', () => {
		const state: AttributionState = {};
		recordToolCall(state, { name: 'read_file', input: { path: 'a' } });
		recordToolCall(state, { name: 'read_file', input: { path: 'b' } });
		expect(state.toolCalls).toHaveLength(2);
	});

	it('treats a `subAgent` without `subAgentId` as a child, not the main agent', () => {
		const state = withDelegation();
		// An older engine — or a frame that lost the id — still says the event came
		// from a child. Falling back to the main agent's list would restore exactly
		// the misattribution this module exists to remove, so it drops instead.
		const where = recordToolCall(state, { name: 'bash', input: {}, subAgent: 'researcher' });
		expect(where).toBe('dropped');
		expect(state.toolCalls ?? []).toEqual([]);
	});
});

describe('recordToolResult', () => {
	it('closes the CHILD call, not the parent identically-named one', () => {
		const state = withDelegation();
		// Both agents run `read_file` at the same time — the normal case for a
		// delegation, not an edge case.
		recordToolCall(state, { name: 'read_file', input: { path: 'parent.txt' } });
		recordToolCall(state, { name: 'read_file', input: { path: 'child.txt' }, subAgentId: 's1:0' });

		const { scope, call } = recordToolResult(state, { name: 'read_file', result: 'child data', subAgentId: 's1:0' });

		expect(scope).toBe('child');
		expect(state.subAgents!['s1:0']!.toolCalls[0]).toMatchObject({ status: 'done', result: 'child data' });
		// The parent's call is untouched and still running — matching by name
		// over one shared list closed THIS one instead.
		expect(state.toolCalls![0]).toMatchObject({ status: 'running' });
		expect(state.toolCalls![0]!.result).toBeUndefined();
		// And the Context panel is not handed a child's tool.
		expect(call).toBeNull();
	});

	it('closes the parent call and hands it back for the Context panel', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'write_file', input: { path: 'out.md' } });

		const { scope, call } = recordToolResult(state, { name: 'write_file', result: 'written' });
		expect(scope).toBe('parent');
		expect(call).toMatchObject({ name: 'write_file', status: 'done', result: 'written' });
	});

	it('marks an errored call as error, on either side', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'bash', input: {}, subAgentId: 's1:1' });
		recordToolResult(state, { name: 'bash', result: 'boom', isError: true, subAgentId: 's1:1' });
		expect(state.subAgents!['s1:1']!.toolCalls[0]).toMatchObject({ status: 'error' });
	});

	it('closes the STILL-RUNNING call, not merely the last same-named one', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'read_file', input: { path: 'a' } });
		recordToolResult(state, { name: 'read_file', result: 'first' });
		recordToolCall(state, { name: 'read_file', input: { path: 'b' } });
		// Two same-named calls, the SECOND still open. `findLast` alone happens to
		// pick it here — so the discriminating case is the reverse order below.
		const { call } = recordToolResult(state, { name: 'read_file', result: 'second' });
		expect(call?.input).toEqual({ path: 'b' });
	});

	it('prefers a running EARLIER call over a closed later one', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'read_file', input: { path: 'a' } });
		recordToolCall(state, { name: 'read_file', input: { path: 'b' } });
		// Reachable via THREAD RESUME, not via the live stream: the server pairs
		// results to calls by `tool_use_id` and the client rehydrates the list
		// verbatim, so a turn can be restored with a later call already closed
		// while an earlier one is not. (The live path cannot produce this — it
		// always closes the FIRST running match, so a mid-stream state where a
		// later call is done and an earlier one is running never arises.)
		state.toolCalls![1]!.status = 'done';
		state.toolCalls![1]!.result = 'b done';
		const { call } = recordToolResult(state, { name: 'read_file', result: 'a done' });
		// `findLast` alone would re-close 'b' and overwrite a result it already
		// has. Running-first does NOT make the name unambiguous — with BOTH
		// running, this still closes 'a' for a result that belongs to 'b'. Name
		// matching stays approximate for one agent's own parallel same-tool
		// calls; what the per-agent lists fixed was the PARENT/CHILD collision,
		// which is a different one.
		expect(call?.input).toEqual({ path: 'a' });
		expect(state.toolCalls![1]!.result).toBe('b done');
	});

	it('falls back to the last matching call when none is still running', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'read_file', input: { path: 'a' } });
		recordToolResult(state, { name: 'read_file', result: 'first' });
		// A late or duplicated result for an already-closed call must update that
		// call, not vanish. Without the findLast fallback the `find(running)` misses
		// and the result is silently dropped.
		const { call } = recordToolResult(state, { name: 'read_file', result: 'second' });
		expect(call).toMatchObject({ result: 'second', status: 'done' });
	});

	it('drops a result for an unknown child instead of closing a parent call', () => {
		const state = withDelegation();
		recordToolCall(state, { name: 'read_file', input: {} });
		const { scope } = recordToolResult(state, { name: 'read_file', result: 'x', subAgentId: 's9:0' });

		expect(scope).toBe('dropped');
		expect(state.toolCalls![0]).toMatchObject({ status: 'running' });
	});
});

describe('progress and completion', () => {
	it('marks a child done and records its wall-clock', () => {
		const state = withDelegation();
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 12 });
		expect(state.subAgents!['s1:0']).toMatchObject({ status: 'done', elapsedS: 12 });
		expect(state.subAgents!['s1:1']!.status).toBe('running');
	});

	it('marks a failed child as error, not done', () => {
		const state = withDelegation();
		applyChildDone(state, { subAgentId: 's1:1', ok: false, elapsedS: 3 });
		expect(state.subAgents!['s1:1']!.status).toBe('error');
	});

	it('resyncs a child whose completion frame was lost', () => {
		const state = withDelegation();
		// The heartbeat is the only correction path for a dropped
		// `spawn_child_done`: a child the engine no longer lists as running has
		// finished, whether or not we saw it finish.
		applySpawnProgress(state, { spawnId: 's1', elapsedS: 20, running: ['s1:1'] });
		expect(state.subAgents!['s1:0']!.status).toBe('done');
		expect(state.subAgents!['s1:1']!.status).toBe('running');
		expect(state.spawns!['s1']!.elapsedS).toBe(20);
	});

	it('does not resurrect a child that already failed', () => {
		const state = withDelegation();
		applyChildDone(state, { subAgentId: 's1:0', ok: false, elapsedS: 2 });
		applySpawnProgress(state, { spawnId: 's1', elapsedS: 20, running: [] });
		expect(state.subAgents!['s1:0']!.status).toBe('error');
	});

	it('leaves a batch it does not know alone', () => {
		const state = withDelegation();
		applySpawnProgress(state, { spawnId: 's9', elapsedS: 99, running: [] });
		expect(state.subAgents!['s1:0']!.status).toBe('running');
		expect(state.spawns!['s1']!.elapsedS).toBe(0);
	});

});

describe('cost per sub-agent', () => {
	it('records what a child spent when it finishes', () => {
		const state = withDelegation();
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 12, costUsd: 0.0143 });
		expect(state.subAgents!['s1:0']!.costUsd).toBe(0.0143);
	});

	it('records the spend of a child that FAILED', () => {
		const state = withDelegation();
		// A child that died halfway still burned tokens. Dropping its cost would
		// make the batch total quietly understate the turn.
		applyChildDone(state, { subAgentId: 's1:1', ok: false, elapsedS: 4, costUsd: 0.0021 });
		expect(state.subAgents!['s1:1']).toMatchObject({ status: 'error', costUsd: 0.0021 });
	});

	it('leaves cost UNSET when the engine reports zero', () => {
		const state = withDelegation();
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 12, costUsd: 0 });
		// A model with no pricing entry reports 0. "$0.0000" reads as "this was
		// free"; absent reads as "we don't know", which is the truth.
		expect(state.subAgents!['s1:0']!.costUsd).toBeUndefined();
	});

	it('ignores a malformed cost instead of poisoning the batch total', () => {
		const state = withDelegation();
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 1, costUsd: 'lots' });
		applyChildDone(state, { subAgentId: 's1:1', ok: true, elapsedS: 1, costUsd: Number.NaN });
		expect(batchTotals(state, 's1').costUsd).toBe(0);
	});

	it('sums the batch from its children', () => {
		const state = withDelegation();
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 12, costUsd: 0.01 });
		applyChildDone(state, { subAgentId: 's1:1', ok: false, elapsedS: 4, costUsd: 0.005 });
		expect(batchTotals(state, 's1').costUsd).toBeCloseTo(0.015, 6);
	});

	it('does not mix two batches into one total', () => {
		const state = withDelegation();
		recordSpawn(state, batch('s2', [{ id: 's2:0', name: 'other' }]), 2000);
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 1, costUsd: 0.01 });
		applyChildDone(state, { subAgentId: 's2:0', ok: true, elapsedS: 1, costUsd: 0.99 });
		expect(batchTotals(state, 's1').costUsd).toBe(0.01);
		expect(batchTotals(state, 's2').costUsd).toBe(0.99);
	});
});

describe('batchTotals elapsed', () => {
	it('is null while anything is still running — the caller uses wall-clock', () => {
		const state = withDelegation();
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 17, costUsd: 0.01 });
		expect(batchTotals(state, 's1').settledElapsedS).toBeNull();
	});

	it('is the LONGEST child once every child has stopped', () => {
		const state = withDelegation();
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 17, costUsd: 0.01 });
		applyChildDone(state, { subAgentId: 's1:1', ok: true, elapsedS: 11, costUsd: 0.01 });
		// The heartbeat freezes at its last 5s tick, so the batch used to read
		// "12s" directly above a child row reading "17s".
		expect(batchTotals(state, 's1').settledElapsedS).toBe(17);
	});

	it('reports nothing for a batch it does not know', () => {
		const state = withDelegation();
		expect(batchTotals(state, 's9')).toMatchObject({ children: [], costUsd: 0, settledElapsedS: null });
	});
});

/**
 * The engine reserves a figure for the batch before any child runs and puts it
 * on the `spawn` event. Nothing read it — a field on the wire with no reader is
 * the same defect as a reducer with no caller, just pointing the other way.
 */
describe('batchTotals — the up-front reservation', () => {
	const withEstimate = (usd: unknown): AttributionState => {
		const state: AttributionState = {};
		recordSpawn(state, { ...batch('s1', [{ id: 's1:0', name: 'researcher' }]), estimatedCostUSD: usd }, 1000);
		return state;
	};

	it('stands in for spend while nothing has settled, marked as an estimate', () => {
		const t = batchTotals(withEstimate(0.04), 's1');
		expect(t.costUsd).toBe(0.04);
		expect(t.costIsEstimate).toBe(true);
	});

	it('is REPLACED by real spend the moment a child settles', () => {
		const state = withEstimate(0.04);
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 9, costUsd: 0.0021 });
		const t = batchTotals(state, 's1');
		// Not 0.0421, and not still 0.04: the reservation was a prediction of this
		// very number, so keeping either alongside it double-counts the batch.
		expect(t.costUsd).toBe(0.0021);
		expect(t.costIsEstimate).toBe(false);
	});

	it('claims nothing when the engine sent no estimate', () => {
		const t = batchTotals(withDelegation(), 's1');
		expect(t.costUsd).toBe(0);
		// `costIsEstimate` false with a zero cost is what makes the caller render
		// nothing at all, rather than a "~$0.0000" that reads as "this is free".
		expect(t.costIsEstimate).toBe(false);
	});

	it('ignores a malformed estimate rather than rendering NaN', () => {
		// `Infinity` is the one that needs `Number.isFinite` — every other value
		// here already fails the `> 0` test (`NaN > 0` is false), so a list
		// without it leaves that check unpinned.
		for (const bad of ['0.04', Number.NaN, Number.POSITIVE_INFINITY, -1, null, undefined]) {
			const t = batchTotals(withEstimate(bad), 's1');
			expect(t.costUsd).toBe(0);
			expect(t.costIsEstimate).toBe(false);
		}
	});
});

/**
 * The event-type strings. Their only use is the `switch` in `chat.svelte.ts`,
 * which vitest cannot import — so a typo there is a case that never runs, with
 * nothing in CI to notice. This does not verify them against the engine (no
 * cross-repo type is reachable here); it makes changing them a deliberate act.
 */
describe('wire event types', () => {
	it('are the names the engine emits', () => {
		expect(SPAWN_EVENT).toBe('spawn');
		expect(SPAWN_PROGRESS_EVENT).toBe('spawn_progress');
		expect(SPAWN_CHILD_DONE_EVENT).toBe('spawn_child_done');
	});
});

describe('two children sharing a name', () => {
	/**
	 * `validateSpawnInput` checks a name's length and control characters, never
	 * its uniqueness — so a batch of two "researcher"s is something the engine
	 * accepts without complaint. Keying the UI on the name merged their work.
	 */
	function twins(): AttributionState {
		const state: AttributionState = {};
		recordSpawn(state, batch('s1', [
			{ id: 's1:0', name: 'researcher' },
			{ id: 's1:1', name: 'researcher' },
		]), 1000);
		return state;
	}

	it('keeps their tool calls apart', () => {
		const state = twins();
		recordToolCall(state, { name: 'web_research', input: { q: 'a' }, subAgent: 'researcher', subAgentId: 's1:0' });
		recordToolCall(state, { name: 'web_research', input: { q: 'b' }, subAgent: 'researcher', subAgentId: 's1:1' });

		expect(state.subAgents!['s1:0']!.toolCalls).toHaveLength(1);
		expect(state.subAgents!['s1:1']!.toolCalls).toHaveLength(1);
		expect(state.subAgents!['s1:0']!.toolCalls[0]!.input).toEqual({ q: 'a' });
	});

	it('keeps their outcomes apart', () => {
		const state = twins();
		applyChildDone(state, { subAgentId: 's1:0', ok: true, elapsedS: 5 });
		applyChildDone(state, { subAgentId: 's1:1', ok: false, elapsedS: 9 });
		expect(state.subAgents!['s1:0']).toMatchObject({ status: 'done', elapsedS: 5 });
		expect(state.subAgents!['s1:1']).toMatchObject({ status: 'error', elapsedS: 9 });
	});
});

describe('a turn without sub-agents', () => {
	it('is untouched by any of this', () => {
		const state: AttributionState = { blocks: [{ type: 'text', text: 'Kurz geprüft.' }] };
		recordToolCall(state, { name: 'read_file', input: { path: 'a' } });
		recordToolResult(state, { name: 'read_file', result: 'ok' });

		expect(state.spawns).toBeUndefined();
		expect(state.subAgents).toBeUndefined();
		expect(state.toolCalls).toEqual([{ name: 'read_file', input: { path: 'a' }, status: 'done', result: 'ok' }]);
		expect(state.blocks).toEqual([
			{ type: 'text', text: 'Kurz geprüft.' },
			{ type: 'tool_call', index: 0 },
		]);
	});
});

describe('foldToolRows', () => {
	const call = (name: string, status: ToolCallInfo['status'] = 'done'): ToolCallInfo =>
		({ name, input: {}, status });
	// Label by tool name, subject = the call's index-free identity, so a fixture can
	// produce same-action-different-subject and same-action-same-subject runs.
	const labelBy = (subjects: string[]) => {
		let i = 0;
		return (tc: ToolCallInfo) => ({ action: tc.name, subject: subjects[i++] ?? '' });
	};

	it('folds a long run of one action into a single row with merged subjects', () => {
		// The regression this exists for: forty reads rendered as forty rows in the
		// sub-agent panel while the identical calls folded into one in the parent.
		const calls = Array.from({ length: 40 }, () => call('read_file'));
		const subjects = Array.from({ length: 40 }, (_, n) => `f${n}.ts`);

		const rows = foldToolRows(calls, labelBy(subjects));

		expect(rows).toHaveLength(1);
		expect(rows[0]!.subjects).toHaveLength(40);
		expect(rows[0]!.action).toBe('read_file');
	});

	it('dedups a repeated subject instead of listing it twice', () => {
		const rows = foldToolRows([call('read_file'), call('read_file')], labelBy(['a.ts', 'a.ts']));
		expect(rows[0]!.subjects).toEqual(['a.ts']);
	});

	it('starts a new row when the action changes, and folds back after it', () => {
		const rows = foldToolRows(
			[call('read_file'), call('bash'), call('read_file')],
			labelBy(['a.ts', 'ls', 'b.ts']),
		);
		expect(rows.map((r) => r.action)).toEqual(['read_file', 'bash', 'read_file']);
	});

	it('lets one error or one running call dominate the row it folded into', () => {
		// A folded row must not report `done` while a member is still running or
		// failed — that is the whole reason the status is ranked rather than
		// last-write-wins. Both orderings, so a reducer that only escalates forward
		// fails the second case.
		const errLast = foldToolRows([call('read_file'), call('read_file', 'error')], labelBy(['a', 'b']));
		expect(errLast[0]!.status).toBe('error');
		const errFirst = foldToolRows([call('read_file', 'error'), call('read_file')], labelBy(['a', 'b']));
		expect(errFirst[0]!.status).toBe('error');
		const running = foldToolRows([call('read_file'), call('read_file', 'running')], labelBy(['a', 'b']));
		expect(running[0]!.status).toBe('running');
	});

	it('folds across a hidden call rather than being split by it', () => {
		// A labeller returning null hides the call. The neighbours are still the same
		// action, so they must end up in ONE row — a fold that treats the hidden call
		// as a boundary would emit two, which is what the parent transcript does not do.
		let n = 0;
		const rows = foldToolRows(
			[call('read_file'), call('internal_thing'), call('read_file')],
			(tc) => {
				n++;
				return tc.name === 'internal_thing' ? null : { action: 'read_file', subject: `s${n}` };
			},
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.subjects).toEqual(['s1', 's3']);
	});
});

describe('worstStatus', () => {
	it('ranks error over running over done, in both argument orders', () => {
		expect(worstStatus('done', 'running')).toBe('running');
		expect(worstStatus('running', 'done')).toBe('running');
		expect(worstStatus('running', 'error')).toBe('error');
		expect(worstStatus('error', 'running')).toBe('error');
		expect(worstStatus('done', 'done')).toBe('done');
	});
});
