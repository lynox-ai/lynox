/**
 * Who did what: attributing a turn's tool activity to the main agent or to a
 * specific delegated sub-agent.
 *
 * The engine has always said so on the wire — every stream event carries
 * `agent`, and events forwarded from a child carry `subAgent` too — but the chat
 * store never read it. Child tool calls were pushed into the same
 * `msg.toolCalls` list as the main agent's, which makes the transcript not
 * merely incomplete but WRONG: work a sub-agent did is shown as the main
 * agent's. This module is where the client finally reads the attribution.
 *
 * Kept out of `chat.svelte.ts` because the interesting part is a reducer over
 * plain data, and a reducer is worth testing on its own.
 */

export interface ToolCallInfo {
	name: string;
	input: unknown;
	result?: string;
	status: 'running' | 'done' | 'error';
}

/** One delegated child, as the UI tracks it. Mirrors the engine's `SpawnedSubAgent`. */
export interface SubAgentActivity {
	/** `<spawnId>:<index>` from the engine. The key everything is filed under. */
	id: string;
	/** Model-chosen label. Display only — two children may share it. */
	name: string;
	role?: string | undefined;
	model?: string | undefined;
	status: 'running' | 'done' | 'error';
	/** Wall-clock, filled in when the child finishes. */
	elapsedS?: number | undefined;
	/** What this child actually spent. Set on completion — including on failure,
	 *  since a child that died halfway still spent what it spent. */
	costUsd?: number | undefined;
	/** This child's own tool calls, in arrival order. Never the parent's. */
	toolCalls: ToolCallInfo[];
}

/** One `spawn_agent` batch. */
export interface SpawnProgress {
	spawnId: string;
	/** Children of this batch, in the order the engine announced them. */
	childIds: string[];
	elapsedS: number;
	/** Client clock at batch start — the fallback elapsed before the first heartbeat. */
	startedAt: number;
}

/** Ordered blocks for interleaved rendering (text ↔ thinking ↔ tools ↔ spawns). */
export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool_call'; index: number }
	/** A delegation, placed where it happened so the sub-agent panel renders in
	 *  chronological order instead of being pinned to a tool row. */
	| { type: 'spawn'; spawnId: string };

/**
 * The slice of a chat message this module owns.
 *
 * Two maps rather than one nested structure: a child event carries only
 * `subAgentId`, so filing it must not require first knowing which batch the
 * child belongs to. `spawns` holds the batch order for rendering; `subAgents`
 * is the flat index the reducer writes into.
 *
 * `toolCalls` and `blocks` are here too, and that is the point: the routing
 * decision — parent list or child list — must live in ONE function that owns
 * both outcomes. Split across a pure helper and a `case` in the store, a test
 * can green-light the helper while the store quietly keeps crediting children
 * to the main agent.
 */
export interface AttributionState {
	toolCalls?: ToolCallInfo[] | undefined;
	blocks?: ContentBlock[] | undefined;
	spawns?: Record<string, SpawnProgress> | undefined;
	subAgents?: Record<string, SubAgentActivity> | undefined;
}

/** Raw wire payload of a `tool_call` / `tool_result` event. */
export interface ToolEventData {
	name?: unknown;
	input?: unknown;
	result?: unknown;
	isError?: unknown;
	subAgent?: unknown;
	subAgentId?: unknown;
}

/** Where an event was filed. `dropped` means attributed to a child we do not know. */
export type Attribution = 'parent' | 'child' | 'dropped';

/** Wire shape of one child on the `spawn` event. */
export interface AnnouncedSubAgent {
	id: string;
	name: string;
	role?: string | undefined;
	model?: string | undefined;
}

/**
 * Read the announced children off a raw `spawn` payload.
 *
 * Strict on `id` and `name` (a child without them cannot be filed or shown) and
 * lenient on the rest. Length caps because both `name` and `model` originate
 * outside the client — the name is model-chosen, the model id can come from the
 * operator's `model_profiles` — and a 4 kB "name" would wreck the layout even
 * though Svelte escapes it.
 */
export function parseAnnouncedSubAgents(raw: unknown): AnnouncedSubAgent[] {
	if (!Array.isArray(raw)) return [];
	const out: AnnouncedSubAgent[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) continue;
		const { id, name, role, model } = item as Record<string, unknown>;
		if (typeof id !== 'string' || id.length === 0) continue;
		if (typeof name !== 'string' || name.length === 0) continue;
		out.push({
			id,
			name: name.slice(0, 64),
			role: typeof role === 'string' ? role.slice(0, 32) : undefined,
			model: typeof model === 'string' ? model.slice(0, 64) : undefined,
		});
	}
	return out;
}

/** Register a batch and its children. Idempotent on replay of the same `spawnId`. */
export function startSpawn(
	state: AttributionState,
	spawnId: string,
	children: AnnouncedSubAgent[],
	startedAt: number,
): void {
	if (!spawnId || children.length === 0) return;
	state.spawns = state.spawns ?? {};
	state.subAgents = state.subAgents ?? {};
	if (state.spawns[spawnId]) return;
	state.spawns[spawnId] = {
		spawnId,
		childIds: children.map((c) => c.id),
		elapsedS: 0,
		startedAt,
	};
	for (const c of children) {
		state.subAgents[c.id] = {
			id: c.id,
			name: c.name,
			role: c.role,
			model: c.model,
			status: 'running',
			toolCalls: [],
		};
	}
}

/**
 * The child an event is attributed to, or `null` for the main agent.
 *
 * A `subAgentId` the client has never seen returns `null` for the CHILD but the
 * caller must still not fall back to the main agent — see `isChildEvent`. That
 * split matters: silently crediting an unknown child's work to the main agent is
 * the exact defect this module exists to remove, so an unattributable event is
 * dropped instead.
 */
export function childFor(state: AttributionState, subAgentId: unknown): SubAgentActivity | null {
	if (typeof subAgentId !== 'string' || subAgentId.length === 0) return null;
	return state.subAgents?.[subAgentId] ?? null;
}

/** True when the engine attributed this event to a child, known to us or not. */
export function isChildEvent(subAgentId: unknown, subAgent: unknown): boolean {
	return (typeof subAgentId === 'string' && subAgentId.length > 0)
		|| (typeof subAgent === 'string' && subAgent.length > 0);
}

/**
 * Find the call a `tool_result` closes, within ONE agent's own call list.
 *
 * Matching by name is only sound because the lists are per-agent now. It used to
 * run over a single shared list, so a child's `read_file` result closed the
 * PARENT's still-running `read_file` — two agents doing the same thing at the
 * same time is the normal case for a delegation, not an edge case.
 */
export function matchToolResult(calls: ToolCallInfo[], name: string): ToolCallInfo | undefined {
	return calls.find((t) => t.name === name && t.status === 'running')
		?? calls.findLast((t) => t.name === name);
}

/**
 * File a `tool_call` on the message, attributed to whoever made it.
 *
 * Owns BOTH outcomes on purpose. A child's call goes on the child's card and
 * never touches `msg.toolCalls`; the parent's keeps the existing dedup and the
 * interleaved block. An event attributed to a child we have no record of (a
 * lost `spawn` frame) is dropped — invisible beats crediting a sub-agent's work
 * to the main agent, which is the defect this whole module removes.
 *
 * `onTextBlockCompleted` fires when pushing this call finalises a preceding
 * text block, so the caller can start auto-speak without waiting for turn_end.
 */
export function recordToolCall(
	state: AttributionState,
	ev: ToolEventData,
	onTextBlockCompleted?: (text: string, blockIndex: number) => void,
): Attribution {
	const name = String(ev.name ?? '');
	if (isChildEvent(ev.subAgentId, ev.subAgent)) {
		const child = childFor(state, ev.subAgentId);
		if (!child) return 'dropped';
		child.toolCalls.push({ name, input: ev.input, status: 'running' });
		return 'child';
	}
	state.toolCalls = state.toolCalls ?? [];
	// Dedup: skip if the last call has the same name, input, and is still running.
	const last = state.toolCalls[state.toolCalls.length - 1];
	if (last && last.name === name && last.status === 'running'
		&& JSON.stringify(last.input) === JSON.stringify(ev.input)) {
		return 'parent';
	}
	const index = state.toolCalls.length;
	state.toolCalls.push({ name, input: ev.input, status: 'running' });
	state.blocks = state.blocks ?? [];
	const prev = state.blocks[state.blocks.length - 1];
	if (prev && prev.type === 'text') onTextBlockCompleted?.(prev.text, state.blocks.length - 1);
	state.blocks.push({ type: 'tool_call', index });
	return 'parent';
}

/**
 * File a `tool_result` against the call it closes, in ITS agent's own list.
 *
 * Returns the closed call so the caller can drive the Context panel — but only
 * for the main agent's calls; a child's tool must not hijack the sidebar away
 * from what the user is actually following.
 */
export function recordToolResult(
	state: AttributionState,
	ev: ToolEventData,
): { scope: Attribution; call: ToolCallInfo | null } {
	const name = String(ev.name ?? '');
	const close = (call: ToolCallInfo | undefined): ToolCallInfo | null => {
		if (!call) return null;
		call.result = String(ev.result ?? '');
		call.status = ev.isError === true ? 'error' : 'done';
		return call;
	};
	if (isChildEvent(ev.subAgentId, ev.subAgent)) {
		const child = childFor(state, ev.subAgentId);
		if (!child) return { scope: 'dropped', call: null };
		close(matchToolResult(child.toolCalls, name));
		return { scope: 'child', call: null };
	}
	return { scope: 'parent', call: close(matchToolResult(state.toolCalls ?? [], name)) };
}

/**
 * Apply a `spawn` event: register the batch, its children, and the block that
 * places the panel where the delegation happened. Returns false for a payload
 * the UI cannot render (no id, no children) so the caller can skip its own
 * side effects too.
 */
export function recordSpawn(state: AttributionState, data: Record<string, unknown>, now: number): boolean {
	const spawnId = typeof data['spawnId'] === 'string' ? data['spawnId'] : '';
	const children = parseAnnouncedSubAgents(data['subAgents']);
	if (!spawnId || children.length === 0) return false;
	if (state.spawns?.[spawnId]) return true; // replayed frame — already placed
	startSpawn(state, spawnId, children, now);
	state.blocks = state.blocks ?? [];
	state.blocks.push({ type: 'spawn', spawnId });
	return true;
}

/** Apply a `spawn_progress` heartbeat. `running` holds child ids. */
export function applySpawnProgress(
	state: AttributionState,
	spawnId: unknown,
	elapsedS: number,
	running: readonly string[],
): void {
	if (typeof spawnId !== 'string') return;
	const batch = state.spawns?.[spawnId];
	if (!batch) return;
	batch.elapsedS = elapsedS;
	// The heartbeat is the resync path for a dropped `spawn_child_done`: anything
	// the engine no longer lists as running has finished, whether or not we saw
	// its completion event. Outcome is unknown, so only 'running' is cleared.
	const stillRunning = new Set(running);
	for (const id of batch.childIds) {
		const child = state.subAgents?.[id];
		if (child && child.status === 'running' && !stillRunning.has(id)) child.status = 'done';
	}
}

/** Apply a `spawn_child_done`. */
export function applyChildDone(
	state: AttributionState,
	subAgentId: unknown,
	ok: boolean,
	elapsedS: number,
	costUsd?: unknown,
): void {
	const child = childFor(state, subAgentId);
	if (!child) return;
	child.status = ok ? 'done' : 'error';
	child.elapsedS = elapsedS;
	// A model with no pricing entry reports 0. Showing "$0.0000" would read as
	// "this was free" rather than "we don't know", so leave it unset instead.
	if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0) child.costUsd = costUsd;
}

/**
 * What a batch cost, and how long it took.
 *
 * Elapsed comes from the children once they are all finished: the heartbeat
 * stops at its last 5s tick, so a batch whose children ran 17s would otherwise
 * be reported as "12s" next to a child row reading "17s". While work is still
 * running the caller's wall-clock is the better number.
 */
export function batchTotals(state: AttributionState, spawnId: string): {
	children: SubAgentActivity[];
	running: SubAgentActivity[];
	costUsd: number;
	settledElapsedS: number | null;
} {
	const batch = state.spawns?.[spawnId];
	const children = (batch?.childIds ?? [])
		.map((id) => state.subAgents?.[id])
		.filter((c): c is SubAgentActivity => !!c);
	const running = children.filter((c) => c.status === 'running');
	return {
		children,
		running,
		costUsd: children.reduce((sum, c) => sum + (c.costUsd ?? 0), 0),
		settledElapsedS: running.length > 0 || children.length === 0
			? null
			: Math.max(...children.map((c) => c.elapsedS ?? 0)),
	};
}

/** True while any child of any batch on this message is still working. */
export function hasRunningChildren(state: AttributionState): boolean {
	return Object.values(state.subAgents ?? {}).some((c) => c.status === 'running');
}
