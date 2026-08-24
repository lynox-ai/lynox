import { getApiBase } from '../config.svelte.js';
import { cpSuppliesLLMKey } from '../utils/billing-tier.js';
import { estimateCost } from '../format.js';
import { t } from '../i18n.svelte.js';
import { mergeDoneUsage, type UsageInfo } from './chat-usage.js';
import {
	recordToolCall,
	recordToolResult,
	recordSpawn,
	applySpawnProgress,
	applyChildDone,
	SPAWN_EVENT,
	SPAWN_PROGRESS_EVENT,
	SPAWN_CHILD_DONE_EVENT,
	isChildEvent,
	type ToolCallInfo,
	type SpawnProgress,
	type SubAgentActivity,
	type ContentBlock,
} from './chat-attribution.js';
import { parseFollowUps, followUpsFromToolInput, stripFollowUpsFromHistory, type FollowUpSuggestion } from './follow-ups.js';
import { projectKnowledgeWrite, performRetire, performReview, reviewRequestBody, parseReviewFailure, carryKnowledgeWrites, allKnowledgeWrites, queueEntriesToChips, anchorKnowledgeChips, type KnowledgeWriteChip } from './knowledge-chip.js';
import { setContext, clearContext } from './context-panel.svelte.js';
import { loadThreads } from './threads.svelte.js';
import { addToast } from './toast.svelte.js';
import { suppressSessionExpiredBanner } from './session.svelte.js';
import { selectPendingPromptHead } from '../utils/pipeline-status.js';
import { selectReattachTarget, shouldRefireOfflineTurn, shouldProbeServerAfterStream, type ReattachTarget, type ReattachOutcome } from '../utils/active-runs.js';
import { originFromEvent, originFromPending, type PromptOrigin } from '../utils/prompt-origin.js';

// Re-export the canonical UsageInfo + helpers from the pure module so existing
// `import { UsageInfo } from './chat.svelte.js'` callers keep working.
export { usageFromDoneEvent } from './chat-usage.js';
export type { UsageInfo } from './chat-usage.js';

// ---------------------------------------------------------------------------
// Follow-up parsing (<follow_ups>…</follow_ups> block extraction)
// ---------------------------------------------------------------------------

// Follow-up suggestion parsing lives in ./follow-ups.ts (pure module, unit-tested).

/** Resolved once per module load — the user's tz doesn't change mid-tab. Server falls back to UTC if `''`. */
const USER_TIMEZONE: string = (() => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
	} catch {
		return '';
	}
})();

// `UsageInfo` and `usageFromDoneEvent` live in ./chat-usage.ts (pure module,
// unit-tested) and are re-exported at the top of this file for back-compat.

/** Single profiled-API call attributed to a chat message. Populated by the
 *  api_cost stream event so the UI can render "$0.0006 (DataForSEO) — /v3/serp/…"
 *  alongside the corresponding tool_result block. */
export interface ApiCallCost {
	tool: string;
	profileId: string;
	profileName: string;
	endpoint: string;
	costUsd: number;
}

export type { ContentBlock } from './chat-attribution.js';

// The DK-UX chip type + its pure projection/resolve logic live in `knowledge-chip.ts` (a
// `.svelte` store can't be imported from a test). Re-exported so existing consumers that
// import it from the chat store keep working.
export type { KnowledgeWriteChip } from './knowledge-chip.js';

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	toolCalls?: ToolCallInfo[];
	/** Ordered blocks for interleaved rendering (text ↔ tool calls) */
	blocks?: ContentBlock[];
	pipeline?: PipelineInfo;
	/** Sub-agent delegations in this turn, keyed by the engine's `spawnId`.
	 *  A map, not a single object: the agent loop runs several `spawn_agent`
	 *  calls concurrently, and the old single field let the second batch
	 *  overwrite the first. */
	spawns?: Record<string, SpawnProgress>;
	/** Flat index of every delegated child in this turn, keyed by child id.
	 *  Holds each child's OWN tool calls — the main agent's stay in `toolCalls`. */
	subAgents?: Record<string, SubAgentActivity>;
	thinking?: string;
	usage?: UsageInfo;
	/** Profiled-API calls fired by this message's tool invocations. Each entry
	 *  pairs with the matching tool_call block in `blocks`/`toolCalls`. */
	apiCalls?: ApiCallCost[];
	queued?: boolean;
	/** Stable id correlating this bubble with its `messageQueue` entry. Set
	 *  while queued, kept after un-queue (cheap) so removeQueuedMessage can
	 *  always identify which queue entry a bubble belongs to. */
	queueId?: string;
	/** Message failed to send (API error, connection lost, etc.) */
	failed?: boolean;
	/** The failure above was marked on a GUESS, because neither server probe
	 *  could be reached — the usual situation when an SSE stream drops due to
	 *  the network going away. Distinct from a failure the server confirmed:
	 *  "absent from /runs/active" and "could not ask /runs/active" look the
	 *  same to the caller, and so do "the transcript says unanswered" and "the
	 *  transcript was unreachable". The auto-refire on reconnect must re-check
	 *  with the server before spending money on this one. */
	failedOffline?: boolean;
	/** Agent-generated follow-up suggestions (parsed from <follow_ups> block) */
	followUps?: FollowUpSuggestion[];
	/** DK-UX: durable-knowledge writes made during this turn, surfaced as inline chips
	 *  (trusted → "gemerkt · rückgängig", untrusted → keep/discard review). CLIENT-ONLY:
	 *  populated from the SSE side-channel, never persisted to the thread and never folded
	 *  back into model context (so a resume cannot re-inject the untrusted wording). */
	knowledgeWrites?: KnowledgeWriteChip[];
	/** Set on a synthetic marker bubble inserted when the engine auto-compacts
	 *  the conversation — renders as an inline "conversation compacted" divider. */
	compactionNote?: { previousPercent: number };
	/** B-full: a display-only failure note persisted for a failed turn. The
	 *  engine sends a structured code (not prose) so the UI renders a localized
	 *  banner; `detail` is a sanitized provider-error snippet. Present only on
	 *  rows the render projection flagged as notes (reload path). */
	note?: { code: string; detail?: string };
	/** ISO timestamp the server persisted this message at (`created_at`), carried
	 *  through the render projection so the UI can show a subtle per-message time.
	 *  Optional/undefined-safe: older persisted rows + not-yet-reconciled live
	 *  messages simply lack it. */
	createdAt?: string;
	/** @internal — tracks whether a tool call happened between text segments */
	_toolSinceText?: boolean;
}

export type { ToolCallInfo, SpawnProgress, SubAgentActivity } from './chat-attribution.js';

export interface PipelineStepInfo {
	id: string;
	task: string;
	inputFrom?: string[];
	status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
	elapsed?: number;
	durationMs?: number;
	/** One-line summary of the step's result, shown on the live checklist. */
	summary?: string;
}

export interface PipelineInfo {
	pipelineId: string;
	name: string;
	steps: PipelineStepInfo[];
}

/** One span of a prompt, tagged with who wrote it (engine v51). */
export interface PromptSegment {
	kind: 'frame' | 'value';
	text: string;
}

/**
 * Read the frame/value segments off a wire payload.
 *
 * Deliberately strict: anything malformed collapses to `undefined`, i.e. the
 * all-frame rendering that predates the split. A half-parsed segment list would
 * be worse than none — it would claim a boundary it cannot back.
 */
function parsePromptSegments(raw: unknown): PromptSegment[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const out: PromptSegment[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) return undefined;
		const kind = (item as Record<string, unknown>)['kind'];
		const text = (item as Record<string, unknown>)['text'];
		if ((kind !== 'frame' && kind !== 'value') || typeof text !== 'string') return undefined;
		out.push({ kind, text });
	}
	return out;
}

export interface PermissionPrompt {
	/** Flattened text. Always present; the only form an older engine sends. */
	question: string;
	/** Frame/value split, when the engine provides it. Absent means all-frame,
	 *  which is exactly how this rendered before the split existed. */
	segments?: PromptSegment[];
	options?: string[];
	/** Timeout in ms from server — used for countdown display */
	timeoutMs?: number;
	/** Timestamp when the prompt was received */
	receivedAt?: number;
	/** Persistent prompt ID (for resumable prompts) */
	promptId?: string;
	/** When true, render the options as multi-select (toggle several + Send)
	 *  instead of single-click auto-send. */
	multiSelect?: boolean;
	/** The workflow step that raised this prompt, when one did. */
	origin?: PromptOrigin;
}

/** Question descriptor inside a multi-question tabs prompt. Mirrors the
 * engine's TabQuestion shape. */
export interface TabsPromptQuestion {
	question: string;
	header?: string;
	options?: string[];
}

/** State for a server-sent multi-question prompt (protocol=2). Populated from
 * the SSE `prompt_tabs` event or restored via /pending-prompt on reconnect. */
export interface TabsPrompt {
	promptId: string;
	questions: TabsPromptQuestion[];
	/** Partial answers the user submitted in a previous connection, restored
	 * on reconnect. Indexed by question position; undefined entries = unanswered. */
	partialAnswers?: (string | null)[];
	timeoutMs?: number;
	receivedAt?: number;
	/** The workflow step that raised this prompt, when one did. */
	origin?: PromptOrigin;
}

interface QueuedMessage {
	id: string;
	task: string;
	files?: FileAttachment[];
	/** Per-run options (effort/thinking/context) preserved across the queue so a
	 *  context-bearing send (e.g. "Bearbeiten"/"Fixen") that lands mid-stream
	 *  still carries its `{kind,id}` preamble when it flushes. */
	runOptions?: RunOptions;
}

function newQueueId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return `q_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Local persistence model — per-thread.
 *
 * One localStorage key `lynox-chat` holds `{ sessionId, threads }` where
 * `threads[threadId]` is that thread's last-known message list. Per-thread
 * storage exists because the previous single-blob model wiped user-turns
 * any time `resumeThread` cleared `messages = []` before the server fetch
 * returned: a mid-flight SSE run hadn't yet persisted the user turn
 * server-side, and the local clear erased the only remaining copy.
 *
 * With the per-thread split:
 *   - resumeThread hydrates from local first (no flash, no loss).
 *   - server fetch is still authoritative once it returns; but if the
 *     server returned FEWER messages than local has, we treat that as
 *     "server mid-persist" and keep local — protects in-flight user turns.
 */
interface PersistedChat {
	sessionId: string | null;
	threads: Record<string, ChatMessage[]>;
	/** Per-thread pending send-queue (messages typed while a run streamed).
	 *  Persisted WITHOUT file payloads — file-bearing queued messages stay
	 *  in-memory only (base64 would blow the localStorage quota and take the
	 *  whole snapshot down with it); on reload their bubble is reconciled to
	 *  `failed` so the user re-sends rather than seeing a silently-stuck pill. */
	queues?: Record<string, { id: string; task: string }[]>;
	/** Per-thread "deferred follow-ups" tray: the un-taken siblings of a pill the
	 *  user clicked, kept visible + clickable so a second matching suggestion
	 *  isn't lost when taking the first (rafael 2026-07-17). Plain {label,task}
	 *  JSON — persisted exactly like `queues`, no payload concern. */
	/**
	 * Retired 2026-08-08 with the deferred-follow-ups tray. Kept on the READ
	 * side of the type so an existing localStorage blob still parses; nothing
	 * writes it any more, and the entries are inert.
	 */
	deferredFollowUps?: Record<string, FollowUpSuggestion[]>;
}

function readPersistedRoot(): PersistedChat {
	if (typeof localStorage === 'undefined') return { sessionId: null, threads: {} };
	try {
		const saved = localStorage.getItem('lynox-chat');
		if (!saved) return { sessionId: null, threads: {} };
		const raw = JSON.parse(saved) as Partial<PersistedChat> & { messages?: ChatMessage[] };
		// Migration: old single-blob format { messages, sessionId } → put
		// those messages under threads[sessionId].
		if (Array.isArray(raw.messages) && !raw.threads) {
			const sid = typeof raw.sessionId === 'string' ? raw.sessionId : null;
			return {
				sessionId: sid,
				threads: sid ? { [sid]: raw.messages } : {},
			};
		}
		return {
			sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
			threads: raw.threads ?? {},
			...(raw.queues ? { queues: raw.queues } : {}),
		};
	} catch { /* corrupt data */ }
	return { sessionId: null, threads: {} };
}

/** Restore a thread's pending send-queue (text-only entries — see PersistedChat.queues). */
function loadPersistedQueue(threadId: string): QueuedMessage[] {
	return (readPersistedRoot().queues?.[threadId] ?? []).map((q) => ({ id: q.id, task: q.task }));
}

function writePersistedRoot(root: PersistedChat): void {
	if (typeof localStorage === 'undefined') return;
	try { localStorage.setItem('lynox-chat', JSON.stringify(root)); }
	catch { /* quota exceeded */ }
}

function loadPersistedChat(): { messages: ChatMessage[]; sessionId: string | null } {
	const root = readPersistedRoot();
	const msgs = root.sessionId ? root.threads[root.sessionId] ?? [] : [];
	return { messages: msgs, sessionId: root.sessionId };
}

/** Read messages for a specific thread; empty array if absent. */
function loadPersistedThread(threadId: string): ChatMessage[] {
	return dropEmptyUserMessages(readPersistedRoot().threads[threadId] ?? []);
}

/**
 * Drop `role: 'user'` messages whose content is empty/whitespace. These are
 * agent-synthesized tool_result replies (e.g. the user's answer to an
 * ask_user prompt) — they survive server persistence as blank user rows and
 * would otherwise render as empty user bubbles after a thread switch.
 */
function dropEmptyUserMessages(list: ChatMessage[]): ChatMessage[] {
	return list.filter(m => m.role !== 'user' || m.content.trim().length > 0);
}

/**
 * Remove a thread's persisted snapshot. Called by threads.svelte.ts on
 * archive/delete so a later resumeThread() for the same id can't
 * falsely "resurrect" stale local messages after the server already
 * forgot the thread.
 */
export function dropPersistedThread(threadId: string): void {
	const root = readPersistedRoot();
	if (threadId in root.threads || root.queues?.[threadId]) {
		delete root.threads[threadId];
		if (root.queues) delete root.queues[threadId];
		if (root.sessionId === threadId) root.sessionId = null;
		writePersistedRoot(root);
	}
}

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistChat(): void {
	if (typeof localStorage === 'undefined') return;
	// Debounce: collapse rapid writes (e.g. during streaming) into one
	if (_persistTimer) clearTimeout(_persistTimer);
	_persistTimer = setTimeout(() => {
		_persistTimer = null;
		persistChatNow();
	}, 500);
}

/** Flush pending persist immediately (e.g. on newChat or page unload). */
function persistChatNow(): void {
	if (_persistTimer) {
		clearTimeout(_persistTimer);
		_persistTimer = null;
	}
	if (typeof localStorage === 'undefined') return;
	const root = readPersistedRoot();
	root.sessionId = sessionId;
	if (sessionId) {
		root.threads[sessionId] = messages;
		// Persist the pending send-queue alongside the messages so a reload
		// mid-stream doesn't strand a queued turn (rafael 2026-06-04). File-
		// bearing entries are dropped here — see PersistedChat.queues.
		const fileless = messageQueue
			.filter((q) => !q.files || q.files.length === 0)
			.map((q) => ({ id: q.id, task: q.task }));
		root.queues = root.queues ?? {};
		if (fileless.length > 0) root.queues[sessionId] = fileless;
		else if (root.queues[sessionId]) delete root.queues[sessionId];
		// Persist the deferred-follow-ups tray alongside, same per-thread shape.
	}
	writePersistedRoot(root);
}

export interface ContextBudget {
	totalTokens: number;
	maxTokens: number;
	usagePercent: number;
	// Cost-aware compaction-budget occupancy (Session._compactionUsagePercent),
	// injected by the engine alongside the honest window-fill `usagePercent`
	// above. Optional: absent on older engines / non-lazy paths. Consumers
	// use it as a COLOR signal only — never render it as a second number,
	// it can diverge from usagePercent on large-window models (#78b).
	budgetPercent?: number | undefined;
}

export interface ChangesetFileInfo {
	file: string;
	status: 'added' | 'modified';
	diff: string;
	added: number;
	removed: number;
}

const persisted = loadPersistedChat();
let messages = $state<ChatMessage[]>(persisted.messages);
let sessionId = $state<string | null>(persisted.sessionId);
// Deferred-follow-ups tray for the current thread (rehydrated on resume/switch).
let isStreaming = $state(false);
let streamingActivity = $state<'thinking' | 'tool' | 'writing' | 'idle'>('idle');
let streamingToolName = $state<string | null>(null);
// Sub-phase emitted by the running tool itself (currently only `api_setup`
// bootstrap with `docs_url`). When set, the activity bar prefers the
// phase label over the generic tool label so a 5–8s extraction shows
// "Reading API docs..." → "Extracting auth..." → "Finalizing draft..."
// instead of a static "Setting up API...". Cleared on tool_result and on
// the next tool_call.
let streamingToolPhase = $state<{ tool: string; phase: string } | null>(null);
// Wall-clock when the currently-running tool call began. Set on each
// tool_call event, cleared when the activity returns to writing/thinking/idle.
// Drives the elapsed-time display in the streaming indicator and sticky
// activity bar so the user can see "Crawlt Webseite... · 42s" instead of
// a static label that gives no signal during long-running tools.
let currentToolStartedAt = $state<number | null>(null);
// Wall-clock when the last SSE event (any kind) was received from the
// server during an active run. Drives the "Verbindung scheint langsam"
// hint when the gap grows beyond the server heartbeat interval.
let lastEventAt = $state<number | null>(null);
// Highest run-event `seq` (from SSE `id:` lines) applied to the current stream.
// PR-D captures it; PR-E uses it as `?since=` to resume `GET /api/runs/:runId/stream`
// after a disconnect — replay-then-tail, never re-run the task. Reset per run.
let lastAppliedSeq = 0;
let pendingPermission = $state<PermissionPrompt | null>(null);
let pendingTabsPrompt = $state<TabsPrompt | null>(null);
let pendingSecretPrompt = $state<{ name: string; prompt: string; keyType?: string; promptId?: string; origin?: PromptOrigin } | null>(null);
let secretPromptGeneration = $state(0);

/** One IMAP/SMTP endpoint as shown in the connect-mail consent step. */
export interface MailConnectServerView { host: string; port: number; secure: boolean }
/** Staged mail-account fields for a `connect_mail` prompt. The password is NOT
 *  part of this — the user enters it in the consent field and it goes straight
 *  to POST /api/mail/accounts, never through chat/SSE. */
export interface MailConnectPromptView {
	promptId?: string;
	id: string;
	displayName: string;
	address: string;
	preset: string;
	type: string;
	imap: MailConnectServerView;
	smtp: MailConnectServerView;
	appPasswordUrl?: string;
	requires2FA?: boolean;
	/** The workflow step that raised this prompt, when one did. */
	origin?: PromptOrigin;
}
let pendingMailConnect = $state<MailConnectPromptView | null>(null);
let mailConnectGeneration = $state(0);

// Pipeline-status-v2 PromptAnchor inputs. Both reset on newChat /
// resumeThread; runStartedAt is set on `pipeline_start`; runPromptCount
// increments on each pending* null→non-null transition while a run is active.
let runStartedAt = $state<number | null>(null);
// Diagnostics TTFB: wall-clock at run dispatch, consumed once on the first
// streamed content event to compute time-to-first-token. Plain let (not $state)
// — it's read inside the SSE handler, never rendered directly.
let runStartAt: number | null = null;
let runPromptCount = $state(0);
// Tier-2: set when the resumed thread's run was `interrupted` (the engine
// restarted mid-run — no cross-restart resume). Drives a Retry banner in the
// chat view. Cleared on retry/dismiss and at the start of every resume.
let runInterrupted = $state<{ runId: string } | null>(null);
// Tier-2: true while re-attached to a live run's resumable stream after a
// reload (GET /api/runs/:runId/stream). Lets the UI distinguish a fresh send
// from a resumed view if needed; isStreaming already gates the activity bar.
let isReattached = false;
// Monotonic owner token for the shared streaming state (isStreaming/activity/
// tool indicators). Every stream producer (_executeRun + reattachRun) claims a
// fresh epoch at start; a producer only clears the shared state in its finally
// if it is STILL the owner — so an ending re-attach can't switch off the
// activity bar of a fresh send that started on the same thread meanwhile.
let streamEpoch = 0;
let chatError = $state<string | null>(null);
let chatErrorDetail = $state<string | null>(null);
let authError = $state(false);
let messageQueue = $state<QueuedMessage[]>([]);

// Auto-speak per-block signal: bumped each time the assistant closes a text
// block during a streaming turn (i.e. a tool call interrupts the text, or
// the turn ends). ChatView watches this counter, reads the matched content,
// and enqueues the playback so block-N starts speaking while block-(N+1) is
// still being written by the model.
let completedTextBlockGen = $state(0);
let completedTextBlockContent = '';
let completedTextBlockKey = '';
function emitCompletedTextBlock(content: string, key: string): void {
	const trimmed = content.trim();
	if (!trimmed) return;
	completedTextBlockContent = content;
	completedTextBlockKey = key;
	completedTextBlockGen++;
}

let sessionModel = $state<string | null>(null);
// The current thread's capability TIER (`fast`/`balanced`/`deep`) — distinct from
// `sessionModel`, which the turn_end SSE frame overwrites with the concrete
// model-id (e.g. `claude-sonnet-4-6`). Set only from the tier-bearing POST/resume/
// re-pick responses (never turn_end), so the per-thread model control (P1 §5.1b)
// always reads a real tier. null before a session exists / on a new chat.
let sessionTier = $state<string | null>(null);
// The tier the composer model picker chose for the NEXT new chat (null = let the
// server use default_tier). Sent as `model` on the session-create POST; cleared on
// newChat() so every new chat starts from default_tier (no stickiness).
let pendingModel = $state<string | null>(null);
let contextWindow = $state<number>(200_000);
let contextBudget = $state<ContextBudget | null>(null);
// Set when the engine offers a "prepare & compact" at the prepare threshold
// (~80%); cleared on compaction or when context drops. Drives the banner's
// compact affordance + a one-time agent suggestion.
let compactionOffer = $state<number | null>(null);
// Hosting tier of this instance. `null` = not yet probed; any non-null
// string = probe completed. Values mirror LYNOX_MANAGED_MODE: 'managed',
// 'managed_pro', 'eu' = instance-supplied LLM; 'starter', 'hosted', '' =
// customer-supplied LLM (BYOK / self-hosted).
let managedTier = $state<string | null>(null);
let managedProbePromise: Promise<void> | null = null;

function probeManagedTier(): Promise<void> {
	if (managedProbePromise) return managedProbePromise;
	managedProbePromise = (async () => {
		try {
			const res = await fetch(`${getApiBase()}/secrets/status`);
			if (res.ok) {
				const data = (await res.json()) as { managed?: string | null };
				managedTier = typeof data.managed === 'string' ? data.managed : '';
			} else {
				managedTier = '';
			}
		} catch {
			managedTier = '';
		}
	})();
	return managedProbePromise;
}

/** True iff the instance supplies the LLM credentials (managed tiers).
 *  Unknown / not-yet-probed also returns true so error copy defaults to
 *  the neutral branch (conservative: avoids showing BYOK hints to a
 *  managed user during the probe race — see feedback_managed_ui_race_default_null). */
function isInstanceSuppliedLlm(): boolean {
	if (managedTier === null) return true;
	return cpSuppliesLLMKey(managedTier);
}
let pendingChangeset = $state<ChangesetFileInfo[] | null>(null);
let changesetLoading = $state(false);
let skipExtraction = $state(false);
let retryStatus = $state<{ attempt: number; maxAttempts: number; reason?: 'retry' | 'busy' } | null>(null);
// Controller for the 409 "busy" poll loop — shared so abortRun() and a
// thread switch can cut it short without waiting for the 3s tick or the
// 6 min cap to elapse. Kept at module scope alongside _resumeController.
let _queuePollController: AbortController | null = null;
/** Held for the duration of the reconnect probe so a burst of `online` events
 *  cannot start two probes — and therefore two billed refires — for one turn. */
let _offlineProbeInFlight = false;
// streamEpoch of the run the user DELIBERATELY stopped (abortRun). Set
// SYNCHRONOUSLY, before the /abort round-trip: the server ends an aborted
// run's stream cleanly WITHOUT a done/error terminal (RunAbortedError →
// res.end(), http-api.ts), so if the stopped run's read loop unblocks
// before abortRun's await resolves, `!sawTerminal && isStreaming` alone
// would misread the deliberate stop as a transport drop — label the turn
// failed (which the online-reconnect listener then auto re-fires, the
// duplicate-run bug this store's guard tests pin). Per-run comparison: a
// new run bumps streamEpoch, so a stale stop can never suppress a later
// run's recovery.
let _userStopEpoch = -1;
let isOffline = $state(typeof navigator !== 'undefined' ? !navigator.onLine : false);

/** Queue a failed user turn for another send. Extracted so the confirmed and
 *  the offline-verified paths below re-fire through exactly one place. */
function refireFailedTurn(msg: ChatMessage): void {
	msg.failed = false;
	msg.queued = true;
	msg.queueId = newQueueId();
	messageQueue.push({ id: msg.queueId, task: msg.content });
	chatError = null;
	// Small delay to let network stabilize
	setTimeout(() => {
		if (messageQueue.length > 0) {
			const next = messageQueue.shift()!;
			void _executeRun(next.task, next.files, undefined, next.runOptions, next.id);
		}
	}, 500);
}

// Offline detection + auto-retry on reconnect
if (typeof window !== 'undefined') {
	window.addEventListener('offline', () => { isOffline = true; });
	window.addEventListener('online', () => {
		isOffline = false;
		// Auto-retry the last failed message
		const lastFailed = [...messages].reverse().find((m) => m.role === 'user' && m.failed);
		if (lastFailed && !isStreaming) {
			// A turn marked failed WITHOUT server confirmation gets asked about
			// first. `failedOffline` means both probes were blind, so "failed" was
			// a guess — and re-POSTing on a guess re-runs and re-bills a turn the
			// engine may well have finished while we were offline. Now that the
			// network is back the question is answerable, so answer it.
			if (lastFailed.failedOffline) {
				// Re-entrancy lock, taken SYNCHRONOUSLY. In the pre-async version the
				// interlock was `failed = false`, set on the spot — a second `online`
				// found nothing to retry. Moving the decision behind an await removed
				// that without replacing it: `failed` now stays true for the whole
				// round trip, and browsers fire `online` in bursts (a Wi-Fi↔cellular
				// handover emits several). Two events, two probes, two billed runs.
				if (_offlineProbeInFlight) return;
				_offlineProbeInFlight = true;
				// Pin the thread this decision belongs to. Every mutation below is
				// guarded on it, because `refireFailedTurn` → `_executeRun` resolves
				// the session through `ensureSession()` — i.e. the CURRENT one. Switch
				// threads while the probe is in flight and thread A's prompt is sent
				// into thread B, which no amount of later reconciling undoes.
				const probeSid = sessionId;
				void (async () => {
					try {
						let reached = false;
						let lastRole: string | undefined;
						let activeRun: boolean | undefined;
						if (!probeSid) return;
						try {
							const ar = await fetch(`${getApiBase()}/runs/active`);
							if (ar.ok) activeRun = selectReattachTarget(await ar.json(), probeSid) !== null;
						} catch { /* leave undefined — treated as blind, not as "no run" */ }
						try {
							const enc = encodeURIComponent(probeSid);
							const r = await fetch(`${getApiBase()}/threads/${enc}/messages`);
							if (r.ok) {
								const md = await r.json() as { messages?: Array<{ role?: string }> };
								// Parsed shape, not just status — see the same guard on the
								// drop path: a captive portal answers 200 with HTML.
								if (Array.isArray(md.messages)) {
									reached = true;
									lastRole = md.messages.at(-1)?.role;
								}
							}
						} catch { /* still blind — shouldRefireOfflineTurn declines */ }
						if (sessionId !== probeSid) return; // thread switched mid-probe
						if (!shouldRefireOfflineTurn({ reached, lastRole, activeRun })) {
							// Answered, still running, or still unverifiable. Either way this
							// turn does not get sent again by itself; the failed bubble keeps
							// its tap-to-retry, which is the user's explicit decision.
							// Only CLEAR the failed state when the server actually told us
							// something — a live run or a persisted answer both mean the
							// bubble is lying.
							if (reached || activeRun === true) {
								lastFailed.failed = false;
								lastFailed.failedOffline = false;
								chatError = null;
								await reconcileThread();
							}
							return;
						}
						lastFailed.failedOffline = false;
						refireFailedTurn(lastFailed);
					} finally {
						_offlineProbeInFlight = false;
					}
				})();
				return;
			}
			refireFailedTurn(lastFailed);
		}
	});
	// Flush pending persist on tab close to prevent data loss
	window.addEventListener('beforeunload', () => persistChatNow());

	// On page load, check for pending prompts from a previous session
	if (sessionId && !isStreaming) {
		void checkPendingPrompt();
	}
}

/**
 * Ensure a backend session exists for the current chat. When `resumeThreadId`
 * is passed, POSTs `{ threadId }` so the engine's `sessionStore.getOrCreate`
 * loads the thread history from SQLite (resume path) rather than creating an
 * empty session. Critical for the 404-recovery path: when the engine has
 * evicted the in-memory session OR was restarted, the next /run call returns
 * 404; without the threadId, recovery would create a brand-new sessionId →
 * agent with zero history → user sees old thread in UI but agent can't see it
 * (2026-05-18 staging QA from rafael prod).
 */
export async function ensureSession(resumeThreadId?: string | null): Promise<string> {
	if (sessionId) return sessionId;
	// Fire the hosting-tier probe alongside session creation — by the time
	// any LLM error surfaces, the tier is known and error copy branches
	// correctly.
	void probeManagedTier();
	// `source` records provenance (P1, DEF-0095): a NON-null pendingModel means the
	// user actively picked → 'user'; an untouched new chat → 'default'. Resume sends
	// no source (createThread is OR IGNORE on an existing thread, so the thread keeps
	// its original provenance). ADVISORY-ONLY server-side — it gates nothing.
	const body: Record<string, unknown> = resumeThreadId
		? { threadId: resumeThreadId }
		: pendingModel
			// The composer picker's tier for this new chat. The engine clamps it to
			// max_tier at the ctor, so an over-ceiling value is safe here.
			? { model: pendingModel, source: 'user' }
			: { source: 'default' };
	const init: RequestInit = {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	};
	const res = await fetch(`${getApiBase()}/sessions`, init);
	if (res.status === 401) throw new SessionExpiredError();
	const data = (await res.json()) as { sessionId: string; model?: string; contextWindow?: number };
	sessionId = data.sessionId;
	if (data.model) { sessionModel = data.model; sessionTier = data.model; }
	if (data.contextWindow) contextWindow = data.contextWindow;
	return sessionId;
}

class SessionExpiredError extends Error {
	constructor() { super('session_expired'); this.name = 'SessionExpiredError'; }
}

function handleSessionExpired(assistantIdx?: number, userMsgIdx?: number): void {
	isStreaming = false;
	streamingActivity = 'idle';
	streamingToolName = null;
	streamingToolPhase = null;
	chatError = t('chat.error_session_expired');
	// We own the auth-failure UX here (dedicated message + auto-redirect) —
	// suppress the AppShell's orange banner so the user doesn't see two
	// stacked notices for the same 401.
	suppressSessionExpiredBanner();
	if (assistantIdx !== undefined && messages[assistantIdx] && !messages[assistantIdx]!.content) messages.splice(assistantIdx, 1);
	if (userMsgIdx !== undefined && messages[userMsgIdx]) messages[userMsgIdx]!.failed = true;
	if (typeof window !== 'undefined') {
		const next = encodeURIComponent(window.location.pathname + window.location.search);
		setTimeout(() => { window.location.href = `/login?next=${next}`; }, 1800);
	}
}

export interface FileAttachment {
	name: string;
	type: string;
	data: string; // base64
}

/** Per-run overrides passed to the engine API. */
export interface RunOptions {
	effort?: 'low' | 'medium' | 'high' | 'max';
	thinking?: 'disabled';
	/**
	 * Chat-with-context entry (Slice C, §4.6): a "💬 Bearbeiten" (kind 'workflow')
	 * / "💬 Fixen" (kind 'run') / "💬 Im Chat beantworten" (kind 'mail') button —
	 * or "💬 N im Chat" (kind 'mail-batch', carrying N selected item ids) — opens
	 * a fresh chat referencing the object(s) being worked on. The server resolves
	 * the ref into a context preamble it prepends to this first message, so the
	 * agent has the object(s) loaded without the user pasting them.
	 */
	context?:
		| { kind: 'workflow' | 'run' | 'mail'; id: string }
		| { kind: 'mail-batch'; ids: string[] };
}

export async function sendMessage(task: string, displayText?: string | FileAttachment[], files?: FileAttachment[], runOptions?: RunOptions): Promise<void> {
	// Overload: sendMessage(task, files?) — backwards compatible
	if (Array.isArray(displayText)) {
		files = displayText;
		displayText = undefined;
	}

	// Block if changeset review is pending — user must review before next run
	if (pendingChangeset) {
		addToast(t('changeset.review_pending'), 'info', 4000);
		// Scroll changeset into view if visible
		setTimeout(() => {
			document.querySelector('[data-changeset-review]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}, 100);
		return;
	}

	// Queue if a run is in progress
	if (isStreaming) {
		const display = displayText ?? task;
		const fileNames = files?.map((f) => f.name).join(', ');
		const id = newQueueId();
		messages.push({ role: 'user', content: fileNames ? `${display}\n📎 ${fileNames}` : display, queued: true, queueId: id, createdAt: new Date().toISOString() });
		messageQueue.push({ id, task, files, ...(runOptions ? { runOptions } : {}) });
		// Flush immediately so a reload before the next persist tick (or before
		// the run ends) can recover the queued turn instead of losing it.
		persistChatNow();
		return;
	}

	await _executeRun(task, files, displayText, runOptions);
}

/** Map HTTP status + error detail to a user-friendly i18n message. */
function mapApiError(status: number, detail: string): string {
	const lower = detail.toLowerCase();
	if (status === 409) return t('chat.error_busy');
	if (status === 401 || lower.includes('authentication') || lower.includes('invalid_api_key') || lower.includes('invalid x-api-key')) {
		authError = true;
		return t('chat.error_auth');
	}
	if (lower.includes('insufficient_quota') || lower.includes('billing') || lower.includes('credit'))
		return isInstanceSuppliedLlm() ? t('chat.error_llm_unavailable') : t('chat.error_insufficient_quota');
	if (lower.includes('content_policy') || lower.includes('content policy') || lower.includes('safety'))
		return t('chat.error_content_policy');
	if (lower.includes('model_not_found') || lower.includes('model not found') || lower.includes('not available'))
		return t('chat.error_model_unavailable');
	if (lower.includes('context_length') || lower.includes('too many tokens') || lower.includes('maximum context'))
		return t('chat.error_context_length');
	if (lower.includes('invalid_request') || status === 400)
		return t('chat.error_invalid_request');
	if (status === 429 || lower.includes('rate_limit'))
		return t('chat.error_rate_limit');
	if (status === 529 || lower.includes('overloaded'))
		return t('chat.error_overloaded');
	return t('chat.error_start');
}

/** True while ANY human prompt is awaiting an answer. Proof the run reached the
 *  server and is parked — used to tell a mid-run drop from a pre-run failure. */
function hasAnyPendingPrompt(): boolean {
	return pendingPermission !== null || pendingTabsPrompt !== null
		|| pendingSecretPrompt !== null || pendingMailConnect !== null;
}

/**
 * Recover a live `/run` whose SSE stream dropped mid-run (mobile background,
 * proxy idle, tab freeze) WITHOUT the user reloading the thread (the #83 bug:
 * the answer to an ask_user prompt looked "not sent" and the continuation only
 * appeared after a manual reload-from-history).
 *
 * If the run is still live server-side, restore any pending prompt (so the user
 * answers INTO the prompt form = a `/reply`, not a normal message that hits the
 * busy path) and re-attach to the run's resumable buffer stream via the SAME
 * tested path a manual reload uses (`reattachRun`). Returns true only when the
 * re-attach actually took over the stream.
 */
async function reattachToActiveRun(sid: string, assistantIdx: number): Promise<ReattachOutcome> {
	let target: ReattachTarget | null = null;
	try {
		const res = await fetch(`${getApiBase()}/runs/active`);
		if (!res.ok) return 'unreachable';
		target = selectReattachTarget(await res.json(), sid);
	} catch {
		return 'unreachable'; // no way to reach the registry — the caller must not
		// read this as "there is no run"; that conflation is what let a finished,
		// billed turn be marked failed and then auto re-fired on reconnect.
	}
	if (!target) return 'no-run'; // registry ANSWERED: run already finished/gone
	// Restore a prompt that survived the disconnect so the reply routes correctly.
	await checkPendingPrompt();
	// Drop an empty in-progress assistant bubble so the re-attach's own lazily
	// created bubble doesn't duplicate it.
	const a = messages[assistantIdx];
	if (a && a.role === 'assistant' && !a.content && !a.blocks?.length && !a.toolCalls?.length) {
		messages.splice(assistantIdx, 1);
	}
	// `since` = what THIS client already rendered, so no event double-renders.
	const since = lastAppliedSeq > 0 ? lastAppliedSeq : target.lastPersistedSeq;
	const epochBefore = streamEpoch;
	await reattachRun(sid, target.runId, since, _resumeGeneration);
	if (streamEpoch !== epochBefore) return 'took-over'; // reattachRun took over + owns teardown
	// Non-takeover: the run finished in the tiny /runs/active → /stream gap
	// (reattachRun 404'd before claiming the stream). We already spliced the empty
	// bubble and may have restored a now-stale prompt, so reconcile to the
	// authoritative persisted transcript instead of leaving the just-finished turn
	// invisible until a manual reload. Return true so the caller skips its own
	// (now stale-indexed) cleanup + tail.
	isStreaming = false;
	streamingActivity = 'idle';
	streamingToolName = null;
	streamingToolPhase = null;
	pendingPermission = null;
	pendingTabsPrompt = null;
	await reconcileThread();
	return 'took-over';
}

async function _executeRun(task: string, files?: FileAttachment[], displayText?: string, runOptions?: RunOptions, queueId?: string): Promise<void> {
	chatError = null;
	retryStatus = null;

	// Offline check
	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		chatError = t('chat.error_offline');
		return;
	}

	let retried = false;
	let sid: string;
	try {
		sid = await ensureSession();
	} catch (err) {
		if (err instanceof SessionExpiredError) {
			handleSessionExpired();
			return;
		}
		throw err;
	}

	// Find and un-queue if this message was already added as queued.
	// Prefer id-based lookup when the run originated from messageQueue;
	// fall back to display-prefix match for the legacy direct-send path.
	let userMsgIdx: number;
	const display = displayText ?? task;
	const queuedIdx = queueId !== undefined
		? messages.findIndex((m) => m.role === 'user' && m.queued && m.queueId === queueId)
		: messages.findIndex((m) => m.role === 'user' && m.queued && m.content.startsWith(display.slice(0, 50)));
	if (queuedIdx !== -1) {
		messages[queuedIdx]!.queued = false;
		messages[queuedIdx]!.failed = false;
		userMsgIdx = queuedIdx;
	} else {
		const fileNames = files?.map((f) => f.name).join(', ');
		messages.push({ role: 'user', content: fileNames ? `${display}\n📎 ${fileNames}` : display, createdAt: new Date().toISOString() });
		userMsgIdx = messages.length - 1;
	}

	const assistantIdx = messages.length;
	messages.push({ role: 'assistant', content: '', toolCalls: [] });

	// Claim ownership of the shared streaming state so an in-flight re-attach
	// that ends mid-send can't switch off this run's activity indicators.
	streamEpoch++;
	const epoch = streamEpoch;
	isStreaming = true;
	// Seed liveness markers so a stale value from the previous run can't
	// flash "Verbindung scheint langsam" for the first ~20s of this run.
	lastEventAt = Date.now();
	runStartAt = Date.now(); // diagnostics TTFB anchor (consumed on first delta)
	currentToolStartedAt = null;

	const payload: Record<string, unknown> = { task, protocol: 2 };
	if (files && files.length > 0) {
		payload['files'] = files;
	}
	if (runOptions?.effort) payload['effort'] = runOptions.effort;
	if (runOptions?.thinking) payload['thinking'] = runOptions.thinking;
	if (runOptions?.context) payload['context'] = runOptions.context;
	// User's local IANA timezone — server threads it into the per-turn
	// `[Now: …]` marker so scheduled times render in user wallclock, not UTC.
	if (USER_TIMEZONE) payload['tz'] = USER_TIMEZONE;

	let res = await fetch(`${getApiBase()}/sessions/${sid}/run`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});

	// Session record missing (e.g. after container restart, eviction) —
	// recreate via the resume path and retry. Without `resumeThreadId`, the
	// backend would mint a fresh empty session and the agent would see zero
	// history despite the UI showing all prior messages (2026-05-18 staging
	// QA: F-404-Recovery from rafael prod). Distinct from 401 which is a
	// cookie-level auth failure handled below.
	if (res.status === 404) {
		const previousThreadId = sid;
		sessionId = null;
		try {
			sid = await ensureSession(previousThreadId);
		} catch (err) {
			if (err instanceof SessionExpiredError) {
				handleSessionExpired(assistantIdx, userMsgIdx);
				return;
			}
			throw err;
		}
		res = await fetch(`${getApiBase()}/sessions/${sid}/run`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
	}

	// Rate limited — show feedback, wait, and retry once
	if (res.status === 429 && !retried) {
		const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10);
		retryStatus = { attempt: 1, maxAttempts: 1 };
		await new Promise(r => setTimeout(r, retryAfter * 1000));
		retryStatus = null;
		retried = true;
		res = await fetch(`${getApiBase()}/sessions/${sid}/run`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
	}

	// Provider error (502/503) — retry once after 2s (Vertex AI cold start)
	if ((res.status === 502 || res.status === 503) && !retried) {
		retryStatus = { attempt: 1, maxAttempts: 1, reason: 'retry' };
		await new Promise(r => setTimeout(r, 2000));
		retryStatus = null;
		retried = true;
		res = await fetch(`${getApiBase()}/sessions/${sid}/run`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
	}

	// Session still running a previous turn (common on mobile PWA: iOS Safari
	// pauses JS when backgrounded → SSE drops → client thinks idle → user resends
	// → server says 409). Show the message as queued, not failed, and poll until
	// the previous run completes.
	if (res.status === 409) {
		// Fast-fail when we already know the engine is blocked on a prompt
		// from this client. Polling for up to 6 min won't unblock anything —
		// the run will only progress once the user answers, and a bare
		// "Agent arbeitet noch — wartet…" banner with the actual prompt
		// hidden somewhere is exactly the dead-end the user reported.
		if (hasAnyPendingPrompt()) {
			// If a prior 409 poll loop is still running (re-entrant call before
			// its finally block ran), cut it now so its tick doesn't flip
			// `isStreaming` back on after we clear it below.
			if (_queuePollController) {
				_queuePollController.abort();
				_queuePollController = null;
			}
			if (messages[userMsgIdx]) {
				messages[userMsgIdx]!.queued = false;
				messages[userMsgIdx]!.failed = true;
			}
			if (messages[assistantIdx] && !messages[assistantIdx]!.content) {
				messages.splice(assistantIdx, 1);
			}
			chatError = t('chat.error_blocked_by_prompt');
			chatErrorDetail = null;
			isStreaming = false;
			streamingActivity = 'idle';
			streamingToolName = null;
			streamingToolPhase = null;
			return;
		}
		if (messages[userMsgIdx]) {
			messages[userMsgIdx]!.queued = true;
			messages[userMsgIdx]!.failed = false;
		}
		const POLL_MS = 3000;
		const MAX_POLLS = 120; // 6 min — long enough to cover heavy research runs
		_queuePollController = new AbortController();
		const signal = _queuePollController.signal;
		let bailedOut = false;
		try {
			for (let attempt = 1; attempt <= MAX_POLLS && res.status === 409; attempt++) {
				// Stop / thread-switch: drop out of the loop without another fetch.
				// `sessionId !== sid` catches navigation to a different thread; the
				// messages[] reactive store has been reassigned to the other thread
				// by then, so we must not mutate userMsgIdx after this point.
				if (signal.aborted || sessionId !== sid) { bailedOut = true; break; }
				retryStatus = { attempt, maxAttempts: MAX_POLLS, reason: 'busy' };
				// Interruptible sleep — abort resolves immediately so stop feels instant.
				await new Promise<void>((resolve) => {
					const t = setTimeout(resolve, POLL_MS);
					signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
				});
				if (signal.aborted || sessionId !== sid) { bailedOut = true; break; }
				try {
					res = await fetch(`${getApiBase()}/sessions/${sid}/run`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(payload),
						signal,
					});
				} catch (err) {
					if (signal.aborted) { bailedOut = true; break; }
					throw err;
				}
			}
		} finally {
			retryStatus = null;
			_queuePollController = null;
		}

		if (bailedOut) {
			// Only mutate the reactive messages[] if we're still on the same
			// session — otherwise the store now belongs to a different thread
			// and userMsgIdx would clobber someone else's message.
			if (sessionId === sid) {
				if (messages[userMsgIdx]) {
					messages[userMsgIdx]!.queued = false;
					messages[userMsgIdx]!.failed = true;
				}
				if (messages[assistantIdx] && !messages[assistantIdx]!.content) {
					messages.splice(assistantIdx, 1);
				}
			}
			isStreaming = false;
			streamingActivity = 'idle';
			streamingToolName = null;
			streamingToolPhase = null;
			return;
		}

		if (messages[userMsgIdx]) messages[userMsgIdx]!.queued = false;
	}

	if (!res.ok || !res.body) {
		isStreaming = false;
	streamingActivity = 'idle';
	streamingToolName = null;
	streamingToolPhase = null;
		// HTTP 401 on /run means the lynox_session cookie is invalid or expired —
		// not the LLM API key. Show the honest copy and bounce to /login so the
		// user can re-authenticate instead of digging in Settings for a key that
		// isn't the problem.
		if (res.status === 401) {
			handleSessionExpired(assistantIdx, userMsgIdx);
			return;
		}
		try { chatErrorDetail = await res.text(); } catch { chatErrorDetail = `HTTP ${res.status}`; }
		chatError = mapApiError(res.status, chatErrorDetail ?? '');
		// Remove empty assistant message and mark user message as failed
		if (messages[assistantIdx] && !messages[assistantIdx]!.content) messages.splice(assistantIdx, 1);
		if (messages[userMsgIdx]) messages[userMsgIdx]!.failed = true;
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	lastAppliedSeq = 0; // fresh run → reset the resume checkpoint
	// Set when a terminal `done` event arrives → the run reached a real end. If
	// the stream instead ends WITHOUT one (EOF/throw), it dropped mid-run and we
	// try to re-attach to the still-live run (#83) instead of ending blind.
	//
	// `error` is DELIBERATELY not terminal here (it was until 2026-08-23). The
	// engine emits `type:'error'` for two different things, and until the `fatal`
	// flag landed the wire did not distinguish them at all: a dead turn
	// (`agent.ts` absolute-iteration limit) and a
	// non-fatal incident it recovers from — `stream.ts` reports an unparsable
	// tool input, substitutes `input:{}` and CONTINUES the turn. Counting the
	// second as terminal short-circuited this whole block, so the run kept going
	// (measured: 152 s, four spawned sub-agents, `completed`/`end_turn`) while the
	// user's bubble read "not sent — tap to retry". The only offered action was
	// the expensive one, on a turn that was already being billed.
	// Which of the two it was is the SERVER's to answer, exactly as for a dropped
	// stream — so an `error` now routes into the same probe instead of deciding
	// blind. See DEF-stream-error-channel-ambiguous for the wire-side half.
	let sawTerminal = false;
	let sawErrorEvent = false;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			let eventType = '';
			let eventSeq = 0;
			for (const line of lines) {
				if (line.startsWith('id: ')) {
					// PR-D: resumable-stream seq. Captured here so a future
					// re-subscribe (PR-E) can resume with `?since=lastAppliedSeq`.
					const s = parseInt(line.slice(4), 10);
					if (Number.isFinite(s)) eventSeq = s;
				} else if (line.startsWith('event: ')) {
					eventType = line.slice(7);
				} else if (line.startsWith('data: ') && eventType) {
					try {
						const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
						if (eventType === 'done') sawTerminal = true;
						else if (eventType === 'error') sawErrorEvent = true;
						handleSSEEvent(eventType, data, assistantIdx, userMsgIdx, { deferErrorDisposition: true });
						if (eventSeq > 0) lastAppliedSeq = eventSeq;
					} catch { /* skip malformed SSE events */ }
					eventType = '';
					eventSeq = 0;
				}
			}
		}
	} catch {
		// SSE connection error — the client NEVER re-POSTs /run from here
		// (2026-08-14, thread 861f3e4b: four run rows sharing one prompt_hash).
		// The old "pre-run" retry slept 2 s and re-POSTed the same payload
		// whenever the stream died with zero applied seq events, treating that
		// as "the run never started". False negative: a run whose provider is
		// erroring/backing off server-side can be minutes live while streaming
		// nothing seq'd (the measured run: 52 s), so the re-POST minted a
		// duplicate billed run out of a transport hiccup. Whether the run is
		// still alive is the SERVER's to answer — the re-attach below asks
		// /runs/active and either takes over the live run or leaves the turn
		// failed for the user's explicit tap-to-retry (chat.send_failed).
	} finally {
		try { reader.cancel(); } catch { /* already closed */ }
	}

	// Stream ended without a terminal done/error while still marked streaming.
	// Three things this must NOT misread:
	//  - a deliberate stop (abortRun): the server ends an aborted stream
	//    terminal-less, and isStreaming only flips after the /abort round-trip —
	//    the epoch stamp tells them apart;
	//  - a thread switch: the read loop of the OLD run keeps running while
	//    `messages` already belongs to the new thread — every mutation below
	//    is sid-guarded (same reasoning as the 409 path above);
	//  - a run that FINISHED inside the drop window: absent from /runs/active
	//    but its answer is already persisted — see the transcript check.
	// Otherwise: ask the SERVER whether the run is still live; re-attach to its
	// resumable stream so the continuation AND any pending prompt recover live —
	// the user never has to reload from history (the #83 bug).
	let reconciledAfterDrop = false;
	// The condition itself lives in `shouldProbeServerAfterStream` — a pure
	// function, so the rule that decides whether a turn gets asked about can be
	// asserted directly instead of through a source-text match on this file.
	if (shouldProbeServerAfterStream({
		sawDone: sawTerminal,
		sawErrorEvent,
		isStreaming,
		userStopped: _userStopEpoch === epoch,
	})) {
		if (sessionId === sid) {
			const reattachOutcome = await reattachToActiveRun(sid, assistantIdx);
			if (reattachOutcome === 'took-over') {
				return; // the re-attach owns streaming state + persistence + queue drain
			}
			// No live run to recover and the stream never reached a terminal
			// event. The client does NOT re-POST the payload (see the catch
			// above) — the next attempt is the user's explicit tap on the failed
			// message. Only a turn that never rendered anything counts as "not
			// sent": a partial answer stays standing (incl. chips/pills —
			// follow-ups and knowledge-write chips intentionally never populate
			// content/blocks/toolCalls).
			const dropped = messages[assistantIdx];
			if (dropped && dropped.role === 'assistant' && !dropped.content && !dropped.blocks?.length && !dropped.toolCalls?.length
				&& !dropped.followUps?.length && !dropped.knowledgeWrites?.length) {
				// Absent from /runs/active does NOT prove "never started": the
				// run may have finished in the drop window with the answer
				// already persisted. Labeling that "not sent" makes tap-to-retry
				// re-run an already-answered (billed) turn — the duplicate-run
				// outcome this whole change exists to prevent. Ask the
				// transcript: only a thread still ending on OUR user message is
				// honestly unsent.
				let answered = false;
				let transcriptReached = false;
				try {
					const enc = encodeURIComponent(sid);
					const r = await fetch(`${getApiBase()}/threads/${enc}/messages`);
					if (r.ok) {
						const md = await r.json() as { messages?: Array<{ role?: string }> };
						// Set only AFTER the body parses as OUR shape. A 200 whose body is
						// not our JSON is the signature of a captive portal — precisely
						// what sits between client and server at the moment a network
						// comes back. Marking "reached" on the status line alone turns
						// that into "the server confirmed an unanswered thread", which is
						// the strongest licence there is to re-fire a billed turn.
						if (Array.isArray(md.messages)) {
							transcriptReached = true;
							answered = md.messages.at(-1)?.role === 'assistant';
						}
					}
				} catch { /* unreachable or unparseable — see failedOffline below */ }
				if (!answered) {
					messages.splice(assistantIdx, 1);
					if (messages[userMsgIdx]) {
						messages[userMsgIdx]!.failed = true;
						// Mark HOW we know. If neither probe reached the server we are
						// guessing, and the `online` listener below used to act on that
						// guess by re-POSTing the turn — re-running and re-billing a run
						// that may well have completed during the outage. Both probes
						// failing together is not an edge case: it is the normal shape
						// of "the network went away", which is also the commonest reason
						// the SSE stream dropped in the first place.
						// The predicate is the TRANSCRIPT alone, not a conjunction with
						// the registry outcome. `no-run` means the registry answered
						// "nothing live" — it does NOT answer "and nothing was ever
						// persisted", which is the question this branch is deciding.
						// `no-run` + unreachable transcript is therefore just as blind as
						// `unreachable` + unreachable transcript, but the conjunction
						// scored it `false` and sent it down the unverified path.
						// Conversely a REACHED transcript settles it on its own: we are
						// in the `!answered` branch, so the server said the thread still
						// ends on our user message.
						messages[userMsgIdx]!.failedOffline = !transcriptReached;
					}
					// An `error` event already put the upstream reason in `chatError`
					// (provider 401, content policy, …). Overwriting it with the generic
					// connection copy would replace a specific, actionable message with a
					// wrong one — the stream did not drop, the engine reported.
					if (!sawErrorEvent) {
						chatError = t('chat.error_connection');
						chatErrorDetail = null;
					}
				} else {
					// The run FINISHED in the drop window and its answer is persisted.
					// Doing nothing here left the empty assistant bubble standing and
					// the billed answer invisible until a manual reload — the exact
					// outcome the sibling non-takeover path fixes with reconcileThread()
					// one screen up. Mirror it — INCLUDING the two lines that make it
					// work: `reconcileThread` opens with `if (isStreaming) return`, and
					// at this point in `_executeRun` `isStreaming` is still true (it is
					// only cleared below, after this whole block). Copying the call
					// without the state reset made it a guaranteed no-op — the bubble
					// stayed and the answer stayed invisible, i.e. exactly the bug this
					// branch claims to fix.
					messages.splice(assistantIdx, 1);
					isStreaming = false;
					streamingActivity = 'idle';
					// The turn DID answer. An error banner left standing over that
					// answer reads "Etwas ist schiefgelaufen. Versuche es nochmal" above
					// the very reply it is denying — and invites exactly the second,
					// billed send this change exists to prevent. The toast already
					// carried the incident (a lost tool call is worth telling); it is
					// the retry-shaped banner that becomes false once the server
					// confirms an answer.
					chatError = null;
					chatErrorDetail = null;
					await reconcileThread();
					reconciledAfterDrop = true;
				}
			}
		}
	}

	isStreaming = false;
	streamingActivity = 'idle';
	streamingToolName = null;
	streamingToolPhase = null;
	pendingPermission = null;
	pendingTabsPrompt = null;
	retryStatus = null;

	// Parse follow-up suggestions from assistant response. FALLBACK only: if the
	// agent used the suggest_follow_ups tool, the tool_call handler already set
	// followUps live — the text parse must not run (there is no trailer to strip,
	// and it must not override the structured pills). Text-form output (legacy or
	// weak models) still lands here.
	// Skipped after a reconcile: `messages` was just replaced from the server, so
	// `assistantIdx` no longer addresses this turn's bubble — and the reconciled
	// messages already carry whatever the server persisted.
	const lastMsg = reconciledAfterDrop ? undefined : messages[assistantIdx];
	if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content && !lastMsg.followUps) {
		const parsed = parseFollowUps(lastMsg.content);
		if (parsed.suggestions.length > 0) {
			lastMsg.followUps = parsed.suggestions;
			lastMsg.content = parsed.cleanText;
			// Also strip from last text block
			if (lastMsg.blocks?.length) {
				const lastBlock = lastMsg.blocks[lastMsg.blocks.length - 1];
				if (lastBlock && lastBlock.type === 'text') {
					const blockParsed = parseFollowUps(lastBlock.text);
					lastBlock.text = blockParsed.cleanText;
				}
			}
		}
	}

	persistChat();

	// Refresh thread list so sidebar reflects updated ordering
	void loadThreads();

	// The first-turn auto-title is written server-side asynchronously (a fast-tier
	// LLM call landing ~1-3s after the run ends), so the loadThreads above — and the
	// early one on first output — race ahead of it and pick up only the naive
	// placeholder title. Re-poll a couple of times on a new thread's first turn so
	// the upgraded title surfaces live in the sidebar + header without a manual
	// refresh. Safe: the server's no-clobber guard means a manual rename still wins.
	if (userMsgIdx === 0) {
		setTimeout(() => { void loadThreads(); }, 2500);
		setTimeout(() => { void loadThreads(); }, 6000);
	}

	// Process queue: send next queued message
	if (messageQueue.length > 0) {
		const next = messageQueue.shift()!;
		persistChatNow(); // queue shrank — keep the durable copy in sync
		// Small delay so the UI updates before next run starts
		setTimeout(() => { void _executeRun(next.task, next.files, undefined, next.runOptions, next.id); }, 100);
	}
}

/**
 * Mirror a turn's delegation state into the Context sidebar.
 *
 * Aggregated across every batch on the turn. The panel is a single view and
 * used to be fed from one `msg.spawn` object, so with two concurrent
 * `spawn_agent` calls it showed only whichever fired last. The inline transcript
 * is the exact, per-batch view; this stays the roll-up.
 */
function syncSpawnContext(msg: ChatMessage): void {
	const children = Object.values(msg.subAgents ?? {});
	if (children.length === 0) return;
	// Keyed by NAME because that is what the panel renders — which means an
	// ambiguous name gets NO entry rather than one twin's tool shown for both.
	// The inline transcript is the exact, id-keyed view.
	const nameCounts = new Map<string, number>();
	for (const c of children) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
	const lastTool: Record<string, string> = {};
	for (const c of children) {
		if (nameCounts.get(c.name) !== 1) continue;
		const last = c.toolCalls[c.toolCalls.length - 1];
		if (last) lastTool[c.name] = last.name;
	}
	setContext({
		type: 'spawn',
		title: 'spawn_agent',
		spawnAgents: children.map((c) => c.name),
		spawnRunning: children.filter((c) => c.status === 'running').map((c) => c.name),
		spawnDone: children
			.filter((c) => c.status !== 'running')
			.map((c) => ({ name: c.name, ok: c.status === 'done', elapsedS: c.elapsedS ?? 0 })),
		spawnLastTool: lastTool,
		spawnElapsedS: Math.max(0, ...Object.values(msg.spawns ?? {}).map((sp) => sp.elapsedS)),
	});
}

/** `deferErrorDisposition`: do NOT decide the turn's fate on an `error` event —
 *  show it, but leave "is this turn dead" to the caller, which asks the server.
 *  Only `_executeRun` passes it (it owns the post-stream probe); `reattachRun`
 *  has no such probe, so it keeps the previous immediate behaviour rather than
 *  silently losing its failure marking. */
function handleSSEEvent(type: string, data: Record<string, unknown>, idx: number, userIdx: number, opts?: { deferErrorDisposition?: boolean }): void {
	// Any event arriving counts as proof the connection is alive. Drives the
	// "Verbindung scheint langsam" hint in StreamingActivityBar when the gap
	// grows beyond the server heartbeat interval (~10s).
	lastEventAt = Date.now();
	const msg = messages[idx];
	if (!msg) return;

	// Diagnostics TTFB: stamp the first streamed content event of the run.
	// One-shot (clears runStartAt) so later deltas don't overwrite it.
	if (runStartAt !== null && (type === 'text' || type === 'thinking' || type === 'tool_call')) {
		const ttfbMs = Date.now() - runStartAt;
		runStartAt = null;
		msg.usage = { ...(msg.usage ?? { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }), ttfbMs };
		// Surface the thread in the nav AS SOON AS the run produces output — a
		// brand-new chat's user message is persisted by now (message_count ≥ 1),
		// but the nav list otherwise only refreshes at run END, so a new chat
		// stayed invisible (and its live run-status dot couldn't show) for the
		// whole first turn (rafael 2026-06-05). One-shot, so it's one extra
		// thread-list fetch per run.
		void loadThreads();
	}

	switch (type) {
		case 'text': {
			const text = String(data['text'] ?? '');
			// Intercept raw API error responses leaked as text
			// Matches: "429 {...}" (status-prefixed) or '{"type":"error",...}' (raw JSON)
			if (/^\d{3}\s*\{.*"error"/i.test(text.trim()) || /^\{.*"type"\s*:\s*"error"/i.test(text.trim())) {
				chatErrorDetail = text;
				const statusMatch = text.trim().match(/^(\d{3})/);
				chatError = mapApiError(statusMatch ? parseInt(statusMatch[1]!, 10) : 0, text);
				if (messages[idx] && !messages[idx]!.content) messages.splice(idx, 1);
				break;
			}
			// Insert newline between text segments separated by tool calls
			if (msg.content && text && msg._toolSinceText) {
				if (!msg.content.endsWith('\n') && !msg.content.endsWith(' ')) {
					msg.content += '\n\n';
				}
			}
			msg.content += text;
			msg._toolSinceText = false;
			streamingActivity = 'writing';
			streamingToolName = null;
			streamingToolPhase = null;
			currentToolStartedAt = null;
			// Interleaved blocks: append to current text block or start new one
			msg.blocks = msg.blocks ?? [];
			const lastBlock = msg.blocks[msg.blocks.length - 1];
			if (lastBlock && lastBlock.type === 'text') {
				lastBlock.text += text;
			} else {
				msg.blocks.push({ type: 'text', text });
			}
			break;
		}
		case 'thinking': {
			const thinkingText = String(data['thinking'] ?? '');
			// An empty delta carries no reasoning — skip it so it can't push a
			// blank thinking block that persists invisibly in msg.blocks.
			if (thinkingText.length === 0) break;
			// Kept as a flat string for persistence + the legacy bottom pill
			// on threads saved before interleaved thinking blocks existed.
			msg.thinking = (msg.thinking ?? '') + thinkingText;
			// Interleaved blocks: append to the running thinking block or start
			// a new one so reasoning shows in chronological order between the
			// text and tool rows instead of collapsed into one trailing pill.
			msg.blocks = msg.blocks ?? [];
			const lastThinkBlock = msg.blocks[msg.blocks.length - 1];
			if (lastThinkBlock && lastThinkBlock.type === 'thinking') {
				lastThinkBlock.text += thinkingText;
			} else {
				// A text segment that precedes thinking just became complete —
				// emit it so auto-speak can start without waiting for turn_end.
				if (lastThinkBlock && lastThinkBlock.type === 'text') {
					emitCompletedTextBlock(lastThinkBlock.text, `msg-${idx}-block-${msg.blocks.length - 1}`);
				}
				msg.blocks.push({ type: 'thinking', text: thinkingText });
			}
			streamingActivity = 'thinking';
			streamingToolName = null;
			streamingToolPhase = null;
			currentToolStartedAt = null;
			break;
		}
		case 'heartbeat':
			// Server keepalive carrying a real event so the SSE comment-line
			// keepalives don't have to suffice. lastEventAt was already bumped
			// at the top of handleSSEEvent — nothing else to do.
			break;
		case 'tool_call': {
			const toolName = String(data['name'] ?? '');
			const toolInput = data['input'];
			// suggest_follow_ups is a terminal, INVISIBLE tool: its input IS the
			// follow-up pills. Populate them directly and render nothing — no tool
			// card, no context flash, not pushed to toolCalls/blocks. The turn ends
			// server-side (endsTurn), so no further model output follows.
			if (toolName === 'suggest_follow_ups') {
				// A CHILD's suggestions are not the main agent's. This short-circuit sat above
				// `recordToolCall`, which is the one function that routes by attribution — so
				// it was the single path that falsified the guarantee stated three lines below
				// it, and a spawned sub-agent's chips replaced the ones the user was looking at.
				// Dropped rather than rendered elsewhere: a child's follow-ups have no surface.
				if (isChildEvent(data['subAgentId'], data['subAgent'])) break;
				const fu = followUpsFromToolInput(toolInput);
				if (fu.length > 0) msg.followUps = fu;
				break;
			}
			// One function owns the routing so a child's call CANNOT land in the main
			// agent's list — see recordToolCall. It reports where the event went; the
			// streaming indicator follows, and a dropped event moves nothing.
			const where = recordToolCall(msg, data, (text, blockIndex) => {
				emitCompletedTextBlock(text, `msg-${idx}-block-${blockIndex}`);
			});
			if (where === 'dropped') break;
			// `_toolSinceText` splits the MAIN agent's prose into a new paragraph after
			// its own tool calls. A child's activity is not a break in the parent's
			// text flow, so it must not set the flag.
			if (where === 'parent') msg._toolSinceText = true;
			streamingActivity = 'tool';
			streamingToolName = toolName;
			streamingToolPhase = null;
			currentToolStartedAt = Date.now();
			// Skip sidebar update for tools whose dedicated stream event carries
			// richer live state. spawn_agent emits a separate 'spawn' event a
			// few ticks later with running/done counts; letting the tool_call
			// path set tool+spawn_agent first causes a visible flash to the
			// generic tool card before the spawn view takes over.
			// A child's tool must not steal the sidebar from the delegation panel the
			// user is following, so the Context switch is parent-only.
			if (where === 'parent' && toolName !== 'ask_user' && toolName !== 'ask_secret' && toolName !== 'spawn_agent') {
				setContext({ type: 'tool', toolName, toolInput, title: toolName });
			}
			break;
		}
		case 'tool_progress': {
			// A running tool emitted a sub-phase. Right now only `api_setup`
			// bootstrap (docs_url path) does this so the agent doesn't sit on
			// a static label for ~5–8s while the docs fetch + Haiku call run.
			// We don't gate on tool name here — any future tool that emits
			// progress events will just light up automatically.
			const tool = String(data['tool'] ?? '');
			const phase = String(data['phase'] ?? '');
			if (tool && phase) {
				streamingToolPhase = { tool, phase };
			}
			break;
		}
		case 'api_cost': {
			// Phase E: http_request emits one of these for every call against a
			// profiled API with a per_call cost. Stored per-message so we can
			// render the cost next to its tool_call block + roll up into the
			// thread footer's usage row.
			const profileId = String(data['profileId'] ?? '');
			const profileName = String(data['profileName'] ?? '');
			const endpoint = String(data['endpoint'] ?? '');
			const tool = String(data['tool'] ?? 'http_request');
			const costUsd = Number(data['costUsd'] ?? 0);
			if (!profileId || !Number.isFinite(costUsd) || costUsd < 0) break;
			const entry: ApiCallCost = { tool, profileId, profileName, endpoint, costUsd };
			msg.apiCalls = [...(msg.apiCalls ?? []), entry];
			const existing = msg.usage ?? { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
			msg.usage = { ...existing, apiCostUsd: (existing.apiCostUsd ?? 0) + costUsd };
			break;
		}
		case 'tool_result': {
			const toolName = String(data['name'] ?? '');
			// Routing again lives in one place: a child's result closes the CHILD's
			// call. The old code searched a single shared list, so a child's
			// `read_file` result closed the parent's still-running `read_file` — and a
			// delegation doing the same thing as its parent is the normal case.
			const { scope, call: tc } = recordToolResult(msg, data);
			if (scope !== 'dropped') persistChat();
			if (tc) {
				setContext({
					type: tc.name === 'write_file' ? 'file' : 'tool',
					toolName: tc.name,
					toolInput: tc.input,
					toolResult: tc.result,
					filePath: tc.name === 'write_file' ? String((tc.input as Record<string, unknown>)?.['path'] ?? '') : undefined,
					title: tc.name,
			});
			}
			streamingToolPhase = null;
			break;
		}
		case SPAWN_EVENT: {
			// Delegation started. Registers the batch, its children, and the block that
			// places the panel where the delegation happened — chronologically, not
			// pinned to whichever tool row came last.
			if (!recordSpawn(msg, data, Date.now())) break;
			streamingActivity = 'tool';
			streamingToolName = 'spawn_agent';
			currentToolStartedAt = Date.now();
			syncSpawnContext(msg);
			break;
		}
		case SPAWN_PROGRESS_EVENT: {
			applySpawnProgress(msg, data);
			syncSpawnContext(msg);
			// Re-arm the waiting label. `spawn_agent` emits the phase once when the
			// batch starts, but a child's tool calls are forwarded onto this same
			// stream, and the `tool_call` case overwrites `streamingToolName` and
			// nulls the phase. So on any child that uses tools the label was lost
			// seconds in and never came back, leaving the indicator stuck on whatever
			// the child's LAST tool was for the rest of a minutes-long wait. This
			// heartbeat runs every 5s while children are still running (and stops when
			// they finish), which makes it the only signal that can restore it. The
			// child's own tool activity still shows in between — that is real and
			// informative; what it must not do is outlive the tool it describes.
			streamingActivity = 'tool';
			streamingToolName = 'spawn_agent';
			streamingToolPhase = { tool: 'spawn_agent', phase: 'waiting' };
			break;
		}
		case SPAWN_CHILD_DONE_EVENT: {
			applyChildDone(msg, data);
			syncSpawnContext(msg);
			break;
		}
		case 'prompt':
			if (!pendingPermission) runPromptCount++;
			pendingPermission = {
				question: String(data['question'] ?? ''),
				segments: parsePromptSegments(data['segments']),
				options: data['options'] as string[] | undefined,
				timeoutMs: data['timeoutMs'] as number | undefined,
				receivedAt: Date.now(),
				promptId: data['promptId'] as string | undefined,
				multiSelect: data['multi_select'] === true,
				origin: originFromEvent(data),
			};
			break;
		case 'prompt_tabs': {
			const questions = Array.isArray(data['questions']) ? (data['questions'] as TabsPromptQuestion[]) : [];
			const promptId = typeof data['promptId'] === 'string' ? data['promptId'] : '';
			if (!promptId || questions.length === 0) break; // malformed, ignore
			if (!pendingTabsPrompt) runPromptCount++;
			pendingTabsPrompt = {
				promptId,
				questions,
				timeoutMs: typeof data['timeoutMs'] === 'number' ? data['timeoutMs'] : undefined,
				receivedAt: Date.now(),
				origin: originFromEvent(data),
			};
			break;
		}
		case 'prompt_error': {
			// Server aborted/expired a pending prompt (SSE disconnect without reconnect,
			// session abort, etc). Clear local state so the UI doesn't leave a dead form.
			const promptId = typeof data['promptId'] === 'string' ? data['promptId'] : '';
			if (pendingPermission?.promptId === promptId) pendingPermission = null;
			if (pendingTabsPrompt?.promptId === promptId) pendingTabsPrompt = null;
			if (pendingSecretPrompt?.promptId === promptId) pendingSecretPrompt = null;
			if (pendingMailConnect?.promptId === promptId) pendingMailConnect = null;
			break;
		}
		case 'secret_prompt':
			if (!pendingSecretPrompt) runPromptCount++;
			pendingSecretPrompt = {
				name: String(data['name'] ?? ''),
				prompt: String(data['prompt'] ?? ''),
				keyType: data['key_type'] as string | undefined,
				promptId: data['promptId'] as string | undefined,
				origin: originFromEvent(data),
			};
			// Reset UI state for fresh prompt (handles retry after cancel)
			secretPromptGeneration++;
			break;
		case 'mail_connect_prompt':
			if (!pendingMailConnect) runPromptCount++;
			pendingMailConnect = {
				promptId: data['promptId'] as string | undefined,
				id: String(data['id'] ?? ''),
				displayName: String(data['displayName'] ?? ''),
				address: String(data['address'] ?? ''),
				preset: String(data['preset'] ?? ''),
				type: String(data['type'] ?? 'personal'),
				imap: data['imap'] as MailConnectServerView,
				smtp: data['smtp'] as MailConnectServerView,
				appPasswordUrl: data['appPasswordUrl'] as string | undefined,
				requires2FA: data['requires2FA'] as boolean | undefined,
				origin: originFromEvent(data),
			};
			mailConnectGeneration++;
			break;
		case 'turn_end': {
			retryStatus = null;
			// Recovery for a dropped/late `tool_result` event: if the agent has
			// finished its turn the engine MUST have received every tool's
			// result server-side (otherwise the model couldn't have produced
			// its final reply). Anything still flagged `running` here is a
			// UI-side ghost — leaving it spinning forever after the answer is
			// already on screen is the bug rafael reported on 2026-05-15
			// (api_setup ✓ visible but inner http_request still spinning).
			//
			// Index-drift invariant: `msg` was resolved at the top of
			// handleSSEEvent for THIS event's run; the backend serialises
			// turn_end strictly after every tool_result for the same run and
			// never interleaves a later run's events into this stream, so
			// `msg` is always the right turn's message here. If the SSE
			// stream's ordering ever weakens, flip the iteration to a
			// run-id / message-id lookup.
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.status === 'running') tc.status = 'done';
				}
			}
			// Use actual model from this turn (may differ from session default due to Haiku downgrade)
			const turnModel = typeof data['model'] === 'string' ? data['model'] : sessionModel;
			if (turnModel && turnModel !== sessionModel) sessionModel = turnModel;
			const usage = data['usage'] as Record<string, number> | undefined;
			if (usage) {
				const baseTok = usage['input_tokens'] ?? 0;
				const cacheRead = usage['cache_read_input_tokens'] ?? 0;
				const cacheWrite = usage['cache_creation_input_tokens'] ?? 0;
				const inTok = baseTok + cacheWrite + cacheRead;
				const outTok = usage['output_tokens'] ?? 0;
				const costUsd = estimateCost(turnModel, {
					input_tokens: baseTok,
					output_tokens: outTok,
					cache_creation_input_tokens: cacheWrite,
					cache_read_input_tokens: cacheRead,
				});
				const prev = msg.usage;
				// stop_reason / iterations feed the opt-in diagnostics panel.
				const turnStop = typeof data['stop_reason'] === 'string' ? data['stop_reason'] : prev?.stopReason;
				const turnIters = typeof usage['iterations'] === 'number' ? usage['iterations'] : prev?.iterations;
				msg.usage = {
					tokensIn: (prev?.tokensIn ?? 0) + inTok,
					tokensOut: (prev?.tokensOut ?? 0) + outTok,
					cacheRead: (prev?.cacheRead ?? 0) + cacheRead,
					cacheWrite: (prev?.cacheWrite ?? 0) + cacheWrite,
					costUsd: (prev?.costUsd ?? 0) + costUsd,
					// Surface the actual dispatched model (e.g. mistral-large-2512
					// vs mistral-small-2603 after auto-downgrade) so the UI can
					// show it next to the cost. Last-write-wins on multi-turn
					// runs — typically only the final turn's model is shown.
					...(turnModel ? { model: turnModel } : prev?.model ? { model: prev.model } : {}),
					// Carry live-only fields the per-turn REPLACE would otherwise drop:
					// third-party API cost (api_cost event) + the client-measured TTFB
					// (set on the first content delta) + diagnostics signals.
					...(prev?.apiCostUsd !== undefined ? { apiCostUsd: prev.apiCostUsd } : {}),
					...(prev?.ttfbMs !== undefined ? { ttfbMs: prev.ttfbMs } : {}),
					...(turnStop !== undefined ? { stopReason: turnStop } : {}),
					...(turnIters !== undefined ? { iterations: turnIters } : {}),
					// Sub-agent spend is written by the terminal `done` frame, so today
					// no turn_end can follow it and this carry is inert. It is here
					// because this rebuild is an explicit allowlist: anything not named
					// is dropped, and "the events happen to arrive in this order" is a
					// weaker guarantee than naming the field.
					...(prev?.spawnCostUsd !== undefined ? { spawnCostUsd: prev.spawnCostUsd } : {}),
				};
				// Context budget is owned solely by the engine `context_budget`
				// event (exact API usage). turn_end no longer writes it — the old
				// path summed cache-reads across sub-calls and only ratcheted up,
				// producing the >100% readouts and a figure that never fell.
			}
			// Final text block: if the assistant ended on text (no trailing tool
			// call), emit it now so auto-speak picks up the closing paragraph.
			// Tool-call paths already emitted earlier; this only fires for the
			// last block of the turn.
			if (msg.blocks && msg.blocks.length > 0) {
				const lastBlock = msg.blocks[msg.blocks.length - 1];
				if (lastBlock && lastBlock.type === 'text') {
					emitCompletedTextBlock(lastBlock.text, `msg-${idx}-block-${msg.blocks.length - 1}-final`);
				}
			}
			break;
		}
		case 'context_budget': {
			const total = data['totalTokens'] as number | undefined;
			const max = data['maxTokens'] as number | undefined;
			const pct = data['usagePercent'] as number | undefined;
			const budgetPct = data['budgetPercent'] as number | undefined;
			if (total != null && max != null && pct != null) {
				contextBudget = {
					totalTokens: total,
					maxTokens: max,
					usagePercent: pct,
					...(budgetPct != null ? { budgetPercent: budgetPct } : {}),
				};
				if (max) contextWindow = max;
			}
			break;
		}
		case 'pipeline_start': {
			const steps = (data['steps'] as Array<{ id: string; task: string; inputFrom?: string[] }>) ?? [];
			msg.pipeline = {
				pipelineId: String(data['pipelineId'] ?? ''),
				name: String(data['name'] ?? ''),
				steps: steps.map(s => ({
					id: String(s.id),
					task: String(s.task),
					inputFrom: s.inputFrom,
					status: 'pending' as const,
				})),
			};
			runStartedAt = Date.now();
			runPromptCount = 0;
			break;
		}
		case 'pipeline_progress': {
			const stepId = String(data['stepId'] ?? '');
			const rawStatus = String(data['status'] ?? '');
			// Engine sends 'started', UI uses 'running'
			const status = (rawStatus === 'started' ? 'running' : rawStatus) as PipelineStepInfo['status'];
			const elapsed = data['elapsed'] as number | undefined;
			const durationMs = data['durationMs'] as number | undefined;
			// Per-step result summary (orchestrated onStepComplete hook).
			const summary = typeof data['summary'] === 'string' ? data['summary'] : undefined;

			// Auto-create pipeline if pipeline_start was missed
			if (!msg.pipeline) {
				msg.pipeline = { pipelineId: '', name: '', steps: [] };
			}

			let step = msg.pipeline.steps.find(s => s.id === stepId);
			if (!step) {
				// Step not yet known — add it dynamically
				step = { id: stepId, task: stepId, status: 'pending' };
				msg.pipeline.steps.push(step);
			}
			step.status = status;
			if (elapsed != null) step.elapsed = elapsed;
			if (durationMs != null) step.durationMs = durationMs;
			if (summary) step.summary = summary;
			break;
		}
		case 'warning': {
			// Engine-init warnings (e.g. thinking-flag dropped on Mistral) — surface as toast.
			// Code-based dispatch lets us i18n the title/body; modelId is interpolated text-safe
			// (Svelte default-escapes via `{...}`, addToast takes a plain string).
			const code = String(data['code'] ?? '');
			// Defensive cap on modelId: server-controlled enum today, but slice prevents
			// a future leak/spam scenario from rendering megabyte strings in the toast UI.
			const modelId = String(data['modelId'] ?? 'unknown').slice(0, 64);
			if (code === 'thinking_not_supported_on_model') {
				// addToast accepts 'success' | 'error' | 'info'; use 'info' for soft
				// degrades (thinking silently dropped). 'error' would be misleading —
				// the call still works, just without reasoning.
				addToast(
					t('chat.warning.thinking_disabled.body').replace('{model}', modelId),
					'info',
					8000,
				);
			} else if (code === 'run_blocked') {
				// A run the engine fail-closed before the LLM (stale managed-credit
				// status, budget reached). 'info' not 'error' — it's transient and
				// recoverable; the inline done.result render carries the full reason.
				const detail = String(data['detail'] ?? '').slice(0, 200);
				addToast(detail ? `${t('chat.run_blocked')}: ${detail}` : t('chat.run_blocked'), 'info', 8000);
			}
			break;
		}
		case 'done': {
			// Engine echoes the authoritative per-run total on the `done` event via
			// `session.getLastRunUsage()` — the same value persisted to RunHistory
			// (`cost_usd`) and surfaced in `/api/history/cost/daily`. Adopt it as
			// the single source of truth for the footer.
			//
			// `mergeDoneUsage` REPLACES (not adds) any `turn_end`-accumulated total
			// because multi-turn agent loops (api_setup, web_research, plan_task,
			// spawn) fire one `turn_end` per LLM call in the loop, and the UI used
			// to sum them while the engine reports a single per-run cumulative
			// figure. The accumulation showed 3-6× actual cost — a credibility
			// bug at HN-launch. Third-party `apiCostUsd` (DataForSEO etc.) is
			// preserved across the replacement because the engine's run-usage
			// covers LLM cost only.
			const merged = mergeDoneUsage(msg.usage, data['usage']);
			if (merged) msg.usage = merged;
			// Silent-turn guard (rafael 2026-05-29): a run that the engine
			// fail-closes BEFORE the LLM (stale managed-credit status, budget
			// reached, content-policy block) never streams a text/tool block —
			// it returns a short reason string that the HTTP API forwards as
			// `done.result`. Without this, `done` only merged usage and the
			// user saw total silence ("null Mitteilung"). Render the trailing
			// result whenever nothing was streamed so the block reason is
			// visible. A NORMAL run already streamed its text into msg.content,
			// so the `!msg.content` guard prevents a duplicate render.
			const streamedText = msg.blocks?.some(b => b.type === 'text' && b.text) ?? false;
			const result = typeof data['result'] === 'string' ? data['result'] : '';
			if (!msg.content && !streamedText && result.trim()) {
				msg.content = result;
				msg.blocks = [{ type: 'text', text: result }];
			}
			// Budget threshold check — usage dashboard Phase 4. Dynamic import
			// keeps the alerts code out of the initial chat-store bundle for
			// cases where the user never completes a run. Fire-and-forget:
			// the alert is supplemental and must never interact with the run
			// lifecycle on failure.
			import('./usage-alerts.svelte.js')
				.then(m => m.checkUsageThreshold())
				.catch(() => { /* ignore — alerting is best-effort */ });
			break;
		}
		case 'retry': {
			const attempt = data['attempt'] as number;
			const maxAttempts = data['maxAttempts'] as number;
			retryStatus = { attempt, maxAttempts };
			break;
		}
		case 'error': {
			retryStatus = null;
			// Agent sends { message: '...' }, http-api catch sends { error: '...' }
			// Upstream LLM provider errors (e.g. Mistral 401 unauthorized) arrive here
			// once the SSE stream is open — without explicit UI surfacing the user
			// previously saw their own bubble and then nothing (silent fail).
			const rawErr = String(data['error'] ?? data['message'] ?? 'Unknown error');
			chatErrorDetail = rawErr;
			chatError = mapApiError(0, rawErr);
			// Stop the spinner so a stale `streamingActivity` indicator doesn't
			// keep ticking after the engine has already emitted the failure event.
			// The outer finally block also clears these once the SSE stream closes,
			// but the engine sometimes keeps the stream open briefly after `error`
			// (heartbeat trailing), and we want the UI to react immediately.
			isStreaming = false;
			streamingActivity = 'idle';
			streamingToolName = null;
			streamingToolPhase = null;
			currentToolStartedAt = null;
			// Toast notification — surfaces the failure even when the user has
			// scrolled the chat error banner off-screen (mobile + long threads).
			// Truncate the raw upstream string so a paragraph-long stack from a
			// noisy provider doesn't blow up the toast layout.
			const detailSnippet = rawErr.length > 140 ? `${rawErr.slice(0, 140)}…` : rawErr;
			addToast(`${t('chat.error_toast_prefix')}: ${detailSnippet}`, 'error', 8000);
			// Remove empty assistant message and mark user message as failed —
			// UNLESS the caller owns that decision. The engine emits `error` both
			// for a dead turn and for an incident it recovers from (see the
			// `sawErrorEvent` declaration), and marking the user's message failed
			// here is what offered "tap to retry" on a run that was still executing
			// and being billed. `_executeRun` defers this and asks the server.
			if (!opts?.deferErrorDisposition) {
				if (messages[idx] && !messages[idx]!.content) messages.splice(idx, 1);
				if (messages[userIdx]) messages[userIdx]!.failed = true;
			}
			break;
		}
		case 'changeset_ready':
			void fetchChangeset();
			break;
		case 'compaction_offer': {
			// Engine reached the prepare threshold — surface a calm offer (banner
			// button + one-time agent suggestion). Not a forced action.
			compactionOffer = (data['usagePercent'] as number | undefined) ?? null;
			break;
		}
		case 'context_compacted': {
			const prevPct = data['previousUsagePercent'] as number | undefined;
			contextBudget = null;
			compactionOffer = null;
			// Persistent inline marker in the transcript — a 5s toast alone
			// left users unsure whether compaction had lost their context.
			messages.push({ role: 'assistant', content: '', compactionNote: { previousPercent: prevPct ?? 0 } });
			addToast(t('context.compacted').replace('{pct}', String(prevPct ?? '?')), 'info', 5000);
			break;
		}
		case 'knowledge_write': {
			// DK-UX: a durable-knowledge write happened this turn. Batch onto the assistant
			// message as an inline chip (trusted → "gemerkt · rückgängig"; untrusted →
			// keep/discard review). Client-side only: persisted with the transcript in
			// localStorage and carried across transcript adoption, but never re-injected
			// into model context — the untrusted wording is shown to the person (that is
			// the chip's purpose), not to the model.
			// Projection + dedup (Tier-2 replay) is pure — see `projectKnowledgeWrite`. Only
			// materialise the array when there is a chip to push, so a malformed (no-id) or
			// duplicate event leaves the message exactly as it was.
			// Dedup against the WHOLE transcript, not just this message: after an adoption
			// anchored a carried chip elsewhere (the reprojection fallback), a Tier-2
			// replay of the same id would otherwise re-add it here as a second,
			// unresolved-looking chip.
			// `msg` is included explicitly in case it is not yet part of `messages`
			// (duplicates in the existing-list are harmless — the check is a `.some`).
			const chip = projectKnowledgeWrite(
				[...allKnowledgeWrites(messages), ...(msg.knowledgeWrites ?? [])], data);
			if (chip) (msg.knowledgeWrites ??= []).push(chip);
			break;
		}
	}
}

export async function replyPermission(answer: string): Promise<void> {
	if (!sessionId) return;
	const promptId = pendingPermission?.promptId;
	pendingPermission = null;
	await postReplyWithRetry(`${getApiBase()}/sessions/${sessionId}/reply`, { answer, promptId });
}

/** One-shot reply for a multi-question tabs prompt. Answers are ordered to
 * match the questions. '__dismissed__' is the canonical per-question skip. */
export async function replyPermissionTabs(answers: string[]): Promise<void> {
	if (!sessionId) return;
	const promptId = pendingTabsPrompt?.promptId;
	if (!promptId) return;
	pendingTabsPrompt = null;
	await postReplyWithRetry(`${getApiBase()}/sessions/${sessionId}/reply-tabs`, { promptId, answers });
}

/** Optionally persist partial answers so a mid-batch reconnect restores
 * progress. Best-effort — failure does not surface to the user. */
export async function postTabProgress(promptId: string, partial: (string | null)[]): Promise<void> {
	if (!sessionId) return;
	try {
		await fetch(`${getApiBase()}/sessions/${sessionId}/tab-progress`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ promptId, partial }),
		});
	} catch { /* best-effort */ }
}

/** POST a reply with a single retry on transient network error. The server
 * is idempotent for repeat promptIds (returns 200 with `idempotent: true`),
 * so retrying is safe. */
async function postReplyWithRetry(url: string, body: Record<string, unknown>): Promise<void> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			// 2xx or expected terminal states (410 expired, 404 stale) are all "done".
			if (res.ok || res.status === 404 || res.status === 410) return;
			// 5xx → retry once
			if (res.status >= 500 && attempt === 0) {
				await new Promise(r => setTimeout(r, 500));
				continue;
			}
			return;
		} catch {
			if (attempt === 0) {
				await new Promise(r => setTimeout(r, 500));
				continue;
			}
			return;
		}
	}
}

/** Result of a vault write attempt — distinguishes the three failure modes
 *  so the agent can react correctly. Mirrors `SecretOutcome` on the engine
 *  side (core/src/types/agent.ts). See PRD/feedback 2026-05-18 for why a
 *  plain boolean wasn't enough. */
export type SecretSubmitResult = 'saved' | 'managed_blocked' | 'vault_error';

/** Vault PUT timeout — if the server doesn't respond within this window we
 *  surface a vault_error to the engine so the user can retry. Without it a
 *  hung connection silently parks the prompt + pendingSecretPrompt=null
 *  state, blocking any further submission. 30 s matches typical proxy idle
 *  timeouts and is generous for a single PUT. */
const SECRET_PUT_TIMEOUT_MS = 30_000;

export async function submitSecret(name: string, value: string): Promise<SecretSubmitResult> {
	if (!sessionId || !pendingSecretPrompt) return 'vault_error';
	const sid = sessionId;
	const promptId = pendingSecretPrompt.promptId;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), SECRET_PUT_TIMEOUT_MS);
	try {
		// Store secret directly in vault (bypasses chat — value never enters SSE/messages)
		const vaultRes = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ value }),
			signal: ac.signal,
		});
		// 403 = managed-tier write-allowlist rejected the name (only the LLM
		// provider keys are user-writable on managed). The agent must NOT
		// retry — surface this as a distinct status so the tool result tells
		// it to escalate to admin provisioning instead of looping.
		clearTimeout(timer);
		const status: SecretSubmitResult = vaultRes.ok
			? 'saved'
			: vaultRes.status === 403
				? 'managed_blocked'
				: 'vault_error';
		pendingSecretPrompt = null;
		await fetch(`${getApiBase()}/sessions/${sid}/secret-saved`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status, promptId }),
		});
		return status;
	} catch {
		clearTimeout(timer);
		pendingSecretPrompt = null;
		// Best-effort notify so the agent isn't stuck waiting — but if the
		// network is completely dead this POST will fail too, in which case
		// the engine's expireOld() / orphan watchdog eventually clears it.
		try {
			await fetch(`${getApiBase()}/sessions/${sid}/secret-saved`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'vault_error', promptId }),
			});
		} catch {/* swallow — engine will expire the prompt */}
		return 'vault_error';
	}
}

export async function cancelSecret(): Promise<void> {
	if (!sessionId || !pendingSecretPrompt) return;
	const promptId = pendingSecretPrompt.promptId;
	pendingSecretPrompt = null;
	await fetch(`${getApiBase()}/sessions/${sessionId}/secret-saved`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ status: 'canceled', promptId }),
	});
}

export function getPendingSecretPrompt() {
	return pendingSecretPrompt;
}

export function getSecretPromptGeneration() {
	return secretPromptGeneration;
}

/** Outcome of a connect-mail submit. On `ok:false` the prompt stays open so
 *  the user can correct the app-password and retry (the engine turn keeps
 *  waiting); the error string drives a toast. */
export interface MailConnectSubmitResult { ok: boolean; error?: string }
const MAIL_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Submit the app-password for a pending connect_mail prompt. The password goes
 * STRAIGHT to POST /api/mail/accounts (the allowed-on-managed route) → vault —
 * it never enters chat, SSE, or the agent context. On success the prompt is
 * settled `connected`; on failure it's left pending for a retry.
 */
export async function submitMailConnect(password: string): Promise<MailConnectSubmitResult> {
	if (!sessionId || !pendingMailConnect) return { ok: false, error: 'No pending connection' };
	const sid = sessionId;
	const p = pendingMailConnect;
	const promptId = p.promptId;
	const body: Record<string, unknown> = {
		id: p.id,
		displayName: p.displayName,
		address: p.address,
		preset: p.preset,
		type: p.type,
		credentials: { user: p.address, pass: password },
	};
	// The route rebuilds preset accounts from the preset table; for 'custom' it
	// needs the explicit servers (which it re-validates via assertPublicHost).
	if (p.preset === 'custom') {
		body['custom'] = { imap: p.imap, smtp: p.smtp };
	}
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), MAIL_CONNECT_TIMEOUT_MS);
	try {
		const res = await fetch(`${getApiBase()}/mail/accounts`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: ac.signal,
		});
		clearTimeout(timer);
		if (!res.ok) {
			const err = (await res.json().catch(() => ({}))) as { error?: string };
			// Keep the prompt pending — the engine turn is still awaiting, the user
			// can correct the password and resubmit.
			return { ok: false, error: err.error ?? `Connection failed (${res.status})` };
		}
		pendingMailConnect = null;
		await fetch(`${getApiBase()}/sessions/${sid}/mail-connected`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: 'connected', promptId }),
		});
		return { ok: true };
	} catch {
		clearTimeout(timer);
		return { ok: false, error: 'Connection failed — please try again.' };
	}
}

export async function cancelMailConnect(): Promise<void> {
	if (!sessionId || !pendingMailConnect) return;
	const promptId = pendingMailConnect.promptId;
	pendingMailConnect = null;
	await fetch(`${getApiBase()}/sessions/${sessionId}/mail-connected`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ status: 'canceled', promptId }),
	});
}

export function getPendingMailConnect() {
	return pendingMailConnect;
}

export function getMailConnectGeneration() {
	return mailConnectGeneration;
}

/**
 * Check the server for a pending prompt that survived a disconnect/refresh.
 * Restores pendingPermission or pendingSecretPrompt so the UI re-shows it.
 */
export async function checkPendingPrompt(): Promise<void> {
	if (!sessionId) return;
	try {
		const res = await fetch(`${getApiBase()}/sessions/${sessionId}/pending-prompt`);
		if (!res.ok) return;
		const data = (await res.json()) as Record<string, unknown>;
		if (!data['pending']) return;

		const promptType = data['promptType'] as string;
		const kind = data['kind'] as string | undefined;
		// Restored the same way for every kind: a prompt that named its workflow
		// while the stream was live must still name it after a reload (v52).
		const origin = originFromPending(data['origin']);
		if (promptType === 'ask_user' && kind === 'tabs' && Array.isArray(data['questions'])) {
			pendingTabsPrompt = {
				promptId: String(data['promptId'] ?? ''),
				questions: data['questions'] as TabsPromptQuestion[],
				partialAnswers: Array.isArray(data['partialAnswers']) ? (data['partialAnswers'] as (string | null)[]) : undefined,
				timeoutMs: data['timeoutMs'] as number | undefined,
				receivedAt: Date.now(),
				origin,
			};
		} else if (promptType === 'ask_user') {
			pendingPermission = {
				question: String(data['question'] ?? ''),
				segments: parsePromptSegments(data['segments']),
				options: data['options'] as string[] | undefined,
				timeoutMs: data['timeoutMs'] as number | undefined,
				receivedAt: Date.now(),
				promptId: data['promptId'] as string | undefined,
				// Restore multi-select pills on reconnect (v33) — without this the
				// prompt degraded to single-select after a reload mid-prompt.
				multiSelect: data['multiSelect'] === true,
				origin,
			};
		} else if (promptType === 'ask_secret') {
			pendingSecretPrompt = {
				name: String(data['secretName'] ?? ''),
				prompt: String(data['question'] ?? ''),
				keyType: data['secretKeyType'] as string | undefined,
				promptId: data['promptId'] as string | undefined,
				origin,
			};
			secretPromptGeneration++;
		} else if (promptType === 'connect_mail' && data['mailConnect']) {
			const mc = data['mailConnect'] as Record<string, unknown>;
			pendingMailConnect = {
				promptId: data['promptId'] as string | undefined,
				id: String(mc['id'] ?? ''),
				displayName: String(mc['displayName'] ?? ''),
				address: String(mc['address'] ?? ''),
				preset: String(mc['preset'] ?? ''),
				type: String(mc['type'] ?? 'personal'),
				imap: mc['imap'] as MailConnectServerView,
				smtp: mc['smtp'] as MailConnectServerView,
				appPasswordUrl: mc['appPasswordUrl'] as string | undefined,
				requires2FA: mc['requires2FA'] as boolean | undefined,
				origin,
			};
			mailConnectGeneration++;
		}
	} catch {
		// Non-critical — prompt check failed, user can still interact normally
	}
}

export async function abortRun(): Promise<void> {
	if (!sessionId) return;
	// Cancel the 409 "busy" poll first (synchronous) so the loop stops
	// re-POSTing /run before the server /abort round-trip even begins.
	_queuePollController?.abort();
	_queuePollController = null;
	// Stamp the stop BEFORE the round-trip — see _userStopEpoch. The server
	// may end the stream (terminal-less) before this fetch resolves, and the
	// run's own cleanup then reads this flag.
	_userStopEpoch = streamEpoch;
	await fetch(`${getApiBase()}/sessions/${sessionId}/abort`, { method: 'POST' });
	isStreaming = false;
	streamingActivity = 'idle';
	streamingToolName = null;
	streamingToolPhase = null;
}

let isCompacting = $state(false);

export function getIsCompacting(): boolean {
	return isCompacting;
}

/**
 * Trigger a manual compaction of the conversation. Server summarizes the
 * history in-place. Safe to call before auto-compact's 75% threshold fires —
 * useful when a single turn is about to blow past the window via a large
 * tool response (see feedback from 2026-04-23 pillar-run: auto-compact ran
 * too late to save tokens).
 */
export async function compactNow(): Promise<{ ok: boolean; error?: string }> {
	if (!sessionId) return { ok: false, error: 'no-session' };
	if (isCompacting) return { ok: false, error: 'already-compacting' };
	if (isStreaming) return { ok: false, error: 'streaming' };

	isCompacting = true;
	try {
		const res = await fetch(`${getApiBase()}/sessions/${sessionId}/compact`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		// Server returns 409 when a /run is in flight; surface that as the same
		// soft error code the local guard uses so the caller can suppress the
		// generic compact_failed toast for an unavoidable race.
		if (res.status === 409) return { ok: false, error: 'streaming' };
		if (!res.ok) {
			const detail = await res.text().catch(() => `HTTP ${res.status}`);
			return { ok: false, error: detail };
		}
		const data = await res.json() as { ok: boolean; summary: string };
		// Show the same visible marker as an auto-compaction so a user-triggered
		// compaction is transparent in the transcript (the manual /compact path has
		// no active SSE to stream context_compacted). The server also persisted it.
		if (data.ok) {
			const prevPct = contextBudget?.usagePercent ?? 0;
			messages.push({ role: 'assistant', content: '', compactionNote: { previousPercent: prevPct } });
		}
		// Reset local state so the UI reflects the compacted server-side view.
		contextBudget = null;
		compactionOffer = null;
		return { ok: data.ok };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	} finally {
		isCompacting = false;
	}
}

async function fetchChangeset(): Promise<void> {
	if (!sessionId) return;
	changesetLoading = true;
	try {
		const res = await fetch(`${getApiBase()}/sessions/${sessionId}/changeset`);
		if (res.ok) {
			const data = (await res.json()) as { hasChanges: boolean; files: ChangesetFileInfo[] };
			if (data.hasChanges && data.files.length > 0) {
				pendingChangeset = data.files;
			}
		}
	} catch { /* best-effort — don't block UX */ }
	finally { changesetLoading = false; }
}

export async function submitChangesetReview(
	action: 'accept' | 'rollback' | 'partial',
	rolledBackFiles?: string[],
): Promise<void> {
	if (!sessionId) return;
	const body: Record<string, unknown> = { action };
	if (action === 'partial' && rolledBackFiles) {
		body['rolledBackFiles'] = rolledBackFiles;
	}
	try {
		await fetch(`${getApiBase()}/sessions/${sessionId}/changeset/review`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	} catch { /* best-effort */ }
	pendingChangeset = null;
}

export function cancelQueue(): void {
	// Remove queued user messages from chat
	messages = messages.filter((m) => !m.queued);
	messageQueue = [];
}

/**
 * Remove a single queued user message — both the rendered bubble and its
 * matching `messageQueue` entry. Matched strictly by `queueId` so duplicate
 * content, custom displayText (where bubble.content ≠ queue.task), and
 * concurrent dequeues don't desync the FIFO. If the queue entry has already
 * been shifted (run is starting), this is a no-op so the run isn't left
 * with an orphaned bubble.
 */
export function removeQueuedMessage(target: ChatMessage): void {
	const id = target.queueId;
	if (id === undefined) return;

	const queueIdx = messageQueue.findIndex((q) => q.id === id);
	if (queueIdx === -1) return;

	const msgIdx = messages.findIndex((m) => m.queueId === id);
	if (msgIdx === -1 || !messages[msgIdx]?.queued) return;

	messages.splice(msgIdx, 1);
	messageQueue.splice(queueIdx, 1);
}

/** DK-UX: undo a just-made trusted durable write (the inline "rückgängig" chip). A USER
 *  action on a user-scope route — retires the active entry (status → superseded). Not an
 *  agent tool, so the agent can never self-undo; only the person clicking can. */
export async function retireKnowledge(msgIdx: number, id: string): Promise<void> {
	const chip = messages[msgIdx]?.knowledgeWrites?.find((w) => w.id === id);
	// The guard, the 2xx gate and the transition live in `performRetire` (tested in the
	// ordinary suite); this wrapper supplies only the transport and the failure toast.
	const outcome = await performRetire(chip, async () => {
		const res = await fetch(`${getApiBase()}/knowledge/entries/${id}/retire`, { method: 'POST' });
		return { ok: res.ok };
	});
	if (outcome === 'failed') addToast(t('chat.knowledge.undo_failed'), 'error', 4000);
}

/** DK-UX: resolve an untrusted durable capture from the inline review chip. Routes to the
 *  EXISTING queue-review endpoint (approve/edit_approve/reject) — a USER act on a user-scope
 *  route, never agent-callable, so the agent can never self-approve its injected capture. */
export async function reviewKnowledge(
	msgIdx: number,
	id: string,
	action: 'approve' | 'edit_approve' | 'reject',
	editedText?: string,
): Promise<void> {
	const chip = messages[msgIdx]?.knowledgeWrites?.find((w) => w.id === id);
	// Success-only transition (incl. "failed edit_approve keeps the editor open") lives in
	// `performReview` (tested in the ordinary suite); this wrapper is transport + toasts.
	const result = await performReview(chip, action, editedText, async () => {
		const res = await fetch(`${getApiBase()}/knowledge/queue/${id}/review`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(reviewRequestBody(action, editedText)),
		});
		if (res.ok) return { ok: true, errorMessage: null };
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		return { ok: false, errorMessage: parseReviewFailure(res.status, body) };
	});
	if (result.outcome === 'failed') {
		addToast(result.errorMessage ?? t('chat.knowledge.review_failed'), 'error', 4000);
	} else if (result.outcome === 'resolved') {
		// One fewer waiting in this thread — the banner must not keep claiming otherwise
		// after the person has just dealt with it.
		void refreshThreadPendingCount();
	}
}

export function getMessages() {
	return messages;
}
/** Add a temporary placeholder message (e.g. voice transcription bubble). Returns its index. */
export function pushPlaceholder(content: string): number {
	const idx = messages.length;
	messages.push({ role: 'user', content, createdAt: new Date().toISOString() });
	return idx;
}
/** Update placeholder content at given index (for live transcription). */
export function updatePlaceholder(idx: number, content: string): void {
	if (idx >= 0 && idx < messages.length) {
		messages[idx] = { ...messages[idx]!, role: 'user', content };
	}
}
/** Remove placeholder at given index. */
export function removePlaceholder(idx: number): void {
	if (idx >= 0 && idx < messages.length) {
		messages.splice(idx, 1);
	}
}
export function getIsStreaming() {
	return isStreaming;
}
export function getStreamingActivity() {
	return streamingActivity;
}
export function getStreamingToolName() {
	return streamingToolName;
}
/** Active sub-phase for the running tool, or null if the tool hasn't
 *  emitted any progress events. Consumers should prefer this label over
 *  the generic `streamingToolName` mapping when set. */
export function getStreamingToolPhase(): { tool: string; phase: string } | null {
	return streamingToolPhase;
}
/** Wall-clock when the currently running tool call began. Null between
 *  tool calls (text/thinking). Consumers should also gate on isStreaming. */
export function getCurrentToolStartedAt(): number | null {
	return currentToolStartedAt;
}
/** Wall-clock of the last SSE event (any kind, incl. server heartbeat).
 *  Used to detect "connection seems slow" without a hard disconnect. */
export function getLastEventAt(): number | null {
	return lastEventAt;
}
/** Highest run-event seq applied to the current stream — the `?since=` value a
 * resumable re-subscribe uses to replay-then-tail after a disconnect (PR-E). */
export function getLastAppliedSeq(): number {
	return lastAppliedSeq;
}
export function getQueueLength() {
	return messageQueue.length;
}

// --- Follow-ups ------------------------------------------------------------
// The deferred-follow-ups tray was removed on 2026-08-08. It captured the
// un-taken siblings of a clicked pill AUTOMATICALLY and pinned them above the
// composer until dismissed by hand, which is the wrong default in two ways: it
// decided for the user what was worth keeping, and it then had to guess whether
// a later, rephrased suggestion was the same one — a string comparison the model
// defeats every turn. It also cost a permanent row of chips on mobile.
// The replacement is an explicit signal (pin what you want to keep), designed
// separately: DEF-followup-pin-explicit.

/** Run a follow-up pill: send it as a fresh in-context turn. */
export function takeFollowUp(clicked: FollowUpSuggestion): void {
	void sendMessage(clicked.task);
}

/** Monotonic counter, bumped each time a streaming text block closes. */
export function getCompletedTextBlockGen(): number {
	return completedTextBlockGen;
}
/** Snapshot of the last completed text block (read after `getCompletedTextBlockGen()` increments). */
export function getCompletedTextBlock(): { content: string; key: string } {
	return { content: completedTextBlockContent, key: completedTextBlockKey };
}
export function getPendingPermission() {
	return pendingPermission;
}
export function getPendingTabsPrompt() {
	return pendingTabsPrompt;
}

/**
 * Unified head-of-queue prompt for the active session. The three legacy
 * pendingX vars stay as separate state (their reply paths differ); this
 * just returns the first non-null in priority order: secret > permission
 * > tabs. PromptAnchor renders the question text; the existing inline
 * forms still drive the answer.
 */
export type PromptKind = 'permission' | 'tabs' | 'secret' | 'mail';

export interface PendingPromptHead {
	kind: PromptKind;
	question: string;
	promptId?: string;
	options?: string[];
	/** The workflow step that raised it. The anchor is the surface shown when
	 *  the dialog is scrolled out of view — i.e. exactly when the user has the
	 *  least context for what they are being asked. */
	origin?: PromptOrigin;
}

export function getPendingPrompt(): PendingPromptHead | null {
	return selectPendingPromptHead(pendingPermission, pendingTabsPrompt, pendingSecretPrompt, pendingMailConnect);
}

/** Epoch ms when the active pipeline run started. null when no run. */
export function getRunStartedAt(): number | null {
	return runStartedAt;
}

/** How many prompts the active run has fired (used for "Frage N" counter). */
export function getRunPromptCount(): number {
	return runPromptCount;
}
export function getChatError() {
	return chatError;
}
export function getChatErrorDetail() {
	return chatErrorDetail;
}
export function getAuthError() {
	return authError;
}
export function getSessionModel() {
	return sessionModel;
}
/** The current thread's capability tier (`fast`/`balanced`/`deep`), or null before
 *  a session exists. Drives the per-thread model control (P1 §5.1b) — unlike
 *  {@link getSessionModel}, never a concrete model-id. */
export function getSessionTier() {
	return sessionTier;
}
export function getContextWindow() {
	return contextWindow;
}
export function getContextBudget() {
	return contextBudget;
}
/** Usage % at which the engine offered "prepare & compact", or null if no
 *  pending offer. Drives the banner's compact affordance + agent suggestion. */
export function getCompactionOffer() {
	return compactionOffer;
}
export function getRetryStatus() {
	return retryStatus;
}
export function getIsOffline() {
	return isOffline;
}
export function clearError() {
	chatError = null;
	chatErrorDetail = null;
	authError = false;
}
export function getPendingChangeset() {
	return pendingChangeset;
}
export function getSkipExtraction() {
	return skipExtraction;
}
export async function toggleSkipExtraction(): Promise<void> {
	const sid = sessionId;
	if (!sid) return;
	const newValue = !skipExtraction;
	skipExtraction = newValue;
	const res = await fetch(`${getApiBase()}/threads/${sid}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ skip_extraction: newValue }),
	});
	if (!res.ok) {
		skipExtraction = !newValue;
	}
	// Refresh thread list so sidebar indicator updates
	void loadThreads();
}
export function getChangesetLoading() {
	return changesetLoading;
}
export function exportAsMarkdown(): string {
	const lines: string[] = [];
	for (const msg of messages) {
		if (msg.role === 'user') {
			lines.push(`## User\n\n${msg.content}\n`);
		} else {
			lines.push(`## lynox\n`);
			if (msg.content) lines.push(`${msg.content}\n`);
		}
		lines.push('---\n');
	}
	return lines.join('\n');
}

export function exportAsJSON(): string {
	return JSON.stringify({ exported: new Date().toISOString(), messages }, null, 2);
}

export function downloadExport(format: 'md' | 'json'): void {
	const content = format === 'md' ? exportAsMarkdown() : exportAsJSON();
	const type = format === 'md' ? 'text/markdown' : 'application/json';
	const ext = format === 'md' ? 'md' : 'json';
	const blob = new Blob([content], { type });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `lynox-chat-${new Date().toISOString().slice(0, 10)}.${ext}`;
	a.click();
	URL.revokeObjectURL(url);
}

export function newChat() {
	// Thread persists in DB — just detach from current session
	messages = [];
	sessionId = null;
	isStreaming = false;
	streamingActivity = 'idle';
	streamingToolName = null;
	streamingToolPhase = null;
	pendingPermission = null;
	pendingTabsPrompt = null;
	pendingSecretPrompt = null;
	pendingMailConnect = null;
	pendingChangeset = null;
	changesetLoading = false;
	skipExtraction = false;
	chatError = null;
	// Detach the interrupted-run banner too — it belongs to the thread we just
	// left, not the empty new chat (the state otherwise leaks across as a stale
	// "run interrupted" warning on a chat that never ran anything).
	runInterrupted = null;
	messageQueue = [];
	sessionModel = null;
	sessionTier = null;
	pendingModel = null; // no stickiness — the next new chat starts at default_tier
	contextBudget = null;
	// The compaction offer belongs to the thread we just left, exactly like
	// `runInterrupted` above. It is a ONE-SHOT engine event (`compaction_offer`)
	// and was only ever cleared by `context_compacted` or a manual `compactNow` —
	// so once any thread crossed the prepare threshold, the offer bar rendered on
	// every subsequent new chat until a page reload, because its render condition
	// is `compactionOffer !== null` and nothing on the new-chat path reset it.
	compactionOffer = null;
	// Thread-scoped: a count of what is waiting in the PREVIOUS conversation is exactly
	// the wrong thing to leave on screen. Re-fetched by `resumeThread` for the new one.
	threadPending = 0;
	// Same class as `compactionOffer`: `retryStatus` renders UNGATED in ChatView
	// (`{#if retryStatus}`) and was only cleared at the top of `_executeRun`, so a
	// thread left mid-retry showed "attempt 2/3" / "busy" on the fresh chat until
	// the next send.
	retryStatus = null;
	runStartedAt = null;
	runPromptCount = 0;
	clearContext();
	persistChatNow();
}

/**
 * How many durable-knowledge writes from THIS thread are still waiting for review.
 *
 * The inline chip is client-only by design — the raw wording of a queued write must never be
 * re-injected on a resume — so a reload loses it and the entries go invisible in the place
 * they were made. The global queue badge answers "there is something, somewhere"; after
 * coming back to one conversation the question is "is anything from HERE waiting", and that
 * is a different one.
 *
 * Count only. The wording stays server-side until a human has reviewed it, which is the whole
 * reason those entries are queued.
 */
let threadPending = $state(0);

export function getThreadPendingCount(): number {
	return threadPending;
}

export async function refreshThreadPendingCount(): Promise<void> {
	const sid = sessionId;
	if (!sid) { threadPending = 0; return; }
	try {
		const res = await fetch(`${getApiBase()}/knowledge/queue/count?thread=${encodeURIComponent(sid)}`);
		if (!res.ok) { threadPending = 0; return; }
		const body = (await res.json()) as { pendingCount?: number };
		// Guarded against a stale response landing after a thread switch: the fetch above may
		// resolve when the user is already elsewhere, and a count from the previous
		// conversation is exactly the wrong thing to show.
		if (sessionId === sid) threadPending = typeof body.pendingCount === 'number' ? body.pendingCount : 0;
	} catch {
		threadPending = 0;
	}
}

export function getSessionId() {
	return sessionId;
}

/** Set the tier the next new chat will run on (composer model picker). Ignored
 *  once a session exists — a new pick on a live thread goes through
 *  {@link repickSessionModel} instead (D18 reverses D1). */
export function setPendingModel(tier: string | null): void {
	if (sessionId) return;
	pendingModel = tier;
}

/** Re-pick the model tier of the CURRENT live/historical thread — the mid-thread
 *  control (arc:model-selector P1 §5.1b, "continue a historical chat on another
 *  model"). PATCHes /api/sessions/:id/model; on success the live session swaps and
 *  the thread row is persisted as a 'user' pick (sticky on resume). Returns a
 *  discriminated result so the caller can surface the downgrade-overflow refusal
 *  (422) as actionable copy. Refuses locally when there is no session yet or a run
 *  is streaming (the server 409s the latter regardless — this is just fast-path UX). */
export async function repickSessionModel(tier: string): Promise<
	| { ok: true; model: string }
	| { ok: false; reason: 'busy' | 'no_session' | 'error' }
	| { ok: false; reason: 'overflow'; targetTier: string; occupancy: number; window: number }
> {
	if (!sessionId) return { ok: false, reason: 'no_session' };
	if (isStreaming) return { ok: false, reason: 'busy' };
	try {
		const res = await fetch(`${getApiBase()}/sessions/${sessionId}/model`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tier }),
		});
		if (res.ok) {
			const data = (await res.json()) as { model?: string; modelId?: string };
			// `model` is the resolved (clamped) TIER; `modelId` is the concrete
			// model-id. Keep sessionModel a model-id (consistent with the turn_end
			// frame + the StatusBar tooltip) and sessionTier the tier (drives the
			// per-thread control). Falling back to the tier only if modelId is absent.
			if (data.model) {
				sessionTier = data.model;
				sessionModel = data.modelId ?? data.model;
			}
			return { ok: true, model: data.model ?? tier };
		}
		if (res.status === 422) {
			const data = (await res.json()) as { targetTier?: string; occupancy?: number; window?: number };
			return { ok: false, reason: 'overflow', targetTier: data.targetTier ?? tier, occupancy: data.occupancy ?? 0, window: data.window ?? 0 };
		}
		if (res.status === 409) return { ok: false, reason: 'busy' };
		return { ok: false, reason: 'error' };
	} catch {
		return { ok: false, reason: 'error' };
	}
}

let _resumeGeneration = 0;
let _resumeController: AbortController | null = null;

export function getRunInterrupted(): { runId: string } | null {
	return runInterrupted;
}

/** Ack an interrupted run (clear the registry row so the nav dot + banner
 * disappear). The run is already dead — there is no cross-restart resume. */
export async function dismissInterruptedRun(): Promise<void> {
	const runId = runInterrupted?.runId;
	runInterrupted = null;
	if (!runId) return;
	try { await fetch(`${getApiBase()}/runs/${runId}`, { method: 'DELETE' }); } catch { /* best-effort ack */ }
}

/** Retry an interrupted run: ack the dead one, then re-send the last user turn
 * as a fresh run (there is no cross-restart resume — the partial output stays
 * in the transcript as history). */
export async function retryInterruptedRun(): Promise<void> {
	let lastUserText = '';
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.role === 'user' && m.content) { lastUserText = m.content; break; }
	}
	await dismissInterruptedRun();
	if (lastUserText) await sendMessage(lastUserText);
}

/**
 * Re-attach to a live run's resumable event stream after a reload/thread-switch
 * (Tier 2). The transcript already shows the run's persisted turns up to
 * `since` (= lastPersistedSeq, read atomically with the transcript); this
 * replays buffered events strictly newer than `since` and live-tails the rest,
 * so the in-flight turn streams in without re-running the task and without
 * double-rendering anything the transcript already showed (AC2/AC3).
 *
 * The assistant placeholder is created LAZILY on the first content event, so an
 * already-finished run (404 / immediate `done`) or an awaiting-input run (no
 * events until the user answers) never leaves an empty bubble.
 */
async function reattachRun(threadId: string, runId: string, since: number, gen: number): Promise<void> {
	// userIdx for handleSSEEvent's error path = the last user message.
	let userIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === 'user') { userIdx = i; break; }
	}

	let assistantIdx = -1;
	const ensureAssistant = (): void => {
		if (assistantIdx >= 0) return;
		messages.push({ role: 'assistant', content: '' });
		assistantIdx = messages.length - 1;
	};

	let res: Response;
	try {
		res = await fetch(`${getApiBase()}/runs/${runId}/stream?since=${since}`);
	} catch {
		return; // network drop — nav poll still reflects the run; user can reload
	}
	// 404 = the run completed between the transcript read and this re-attach
	// (benign race) — the transcript already has it; nothing to stream.
	if (!res.ok || !res.body) return;
	if (gen !== _resumeGeneration) { try { await res.body.cancel(); } catch { /* */ } return; }

	const myEpoch = ++streamEpoch;
	isStreaming = true;
	isReattached = true;
	lastAppliedSeq = since;
	streamingActivity = 'thinking';

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	// True only when the stream ended with the buffer's terminal `done` (run
	// complete). On a drop/supersede this stays false so the finally does NOT
	// auto-reconcile-then-reattach — that could spin against a still-live run;
	// the nav poll + the next user action recover instead.
	let completedNormally = false;
	try {
		let outerDone = false;
		while (!outerDone) {
			const { done, value } = await reader.read();
			if (done) break;
			if (gen !== _resumeGeneration) break; // superseded by a newer resume
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop() ?? '';
			let eventType = '';
			let eventSeq = 0;
			for (const line of lines) {
				if (line.startsWith('id: ')) {
					const s = parseInt(line.slice(4), 10);
					if (Number.isFinite(s)) eventSeq = s;
				} else if (line.startsWith('event: ')) {
					eventType = line.slice(7);
				} else if (line.startsWith('data: ') && eventType) {
					if (eventType === 'done') { outerDone = true; completedNormally = true; eventType = ''; continue; }
					if (eventType === 'heartbeat') { lastEventAt = Date.now(); eventType = ''; eventSeq = 0; continue; }
					try {
						const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
						ensureAssistant();
						handleSSEEvent(eventType, data, assistantIdx, userIdx);
						if (eventSeq > 0) lastAppliedSeq = eventSeq;
					} catch { /* skip malformed */ }
					eventType = '';
					eventSeq = 0;
				}
			}
		}
	} catch {
		// Re-attach stream dropped — leave what streamed in place; the nav poll
		// keeps reflecting the run and a further reload re-attaches again.
	} finally {
		try { await reader.cancel(); } catch { /* already closed */ }
		// Only clear the shared streaming state if we are STILL its owner — a
		// fresh send (_executeRun) or a newer re-attach bumps streamEpoch and
		// takes ownership, and must not have its activity bar switched off by
		// this finally. Same idea as the gen guard, but covers a same-thread
		// fresh send (which does NOT bump _resumeGeneration).
		if (streamEpoch === myEpoch) {
			isReattached = false;
			isStreaming = false;
			streamingActivity = 'idle';
			streamingToolName = null;
			streamingToolPhase = null;
		}
		// Drop an empty placeholder (run had already finished / produced nothing).
		if (assistantIdx >= 0 && !messages[assistantIdx]?.content && !messages[assistantIdx]?.blocks?.length) {
			messages.splice(assistantIdx, 1);
		}
		// Reconcile to the AUTHORITATIVE persisted transcript once the re-attach
		// ends and we still own the view. The re-attach replayed buffered stream
		// events for immediacy but cannot carry the run's terminal `done.usage`
		// (authoritative per-run cost — replayed turn_end events would otherwise
		// inflate the footer 3-6x), the fail-closed `done.result` reason, or the
		// post-run changeset signal. The persisted message carries the correct
		// usage + any failure note; re-fetch it and surface a pending changeset.
		if (completedNormally && streamEpoch === myEpoch && gen === _resumeGeneration) {
			await reconcileThread();
			await fetchChangeset();
			// Drain a send-queue entry typed mid-re-attach. The resumeThread
			// comment above ("the queued turn drains after it") assumes THIS
			// finally drains it — but it never did, so a message typed while a
			// resumed run streamed sat in the queue forever. Mirror the
			// normal-path drain in _executeRun's finally; skip if the resumed
			// run left a changeset to review (sendMessage's guard is bypassed
			// because we call _executeRun directly).
			if (!pendingChangeset && messageQueue.length > 0) {
				const next = messageQueue.shift()!;
				persistChatNow(); // queue shrank — keep the durable copy in sync
				setTimeout(() => { void _executeRun(next.task, next.files, undefined, next.runOptions, next.id); }, 100);
			}
		}
		persistChat();
	}
}

/**
 * Prepare a server transcript for display before it replaces the local copy.
 * The server persists the agent's RAW output, so the last assistant turn still
 * carries the `<follow_ups>` / bare-JSON trailer in its content — rendering it
 * verbatim leaks that JSON into the bubble and the pills never reappear. Strip
 * it, then re-derive the pills from a `suggest_follow_ups` tool call on the last
 * assistant turn (structured pills win over the text fallback). Shared by BOTH
 * adopt paths (resumeThread + reconcileThread) — reconcile used to skip it, so a
 * settled shorter (#4-merged) transcript adopted on mount leaked the trailer.
 */
function hydrateServerTranscript(serverMessages: ChatMessage[]): void {
	stripFollowUpsFromHistory(serverMessages);
	for (let i = serverMessages.length - 1; i >= 0; i -= 1) {
		const m = serverMessages[i];
		if (!m || m.role !== 'assistant') continue;
		const tc = m.toolCalls?.find((t) => t.name === 'suggest_follow_ups');
		if (tc) {
			const fu = followUpsFromToolInput(tc.input);
			if (fu.length > 0) m.followUps = fu;
		}
		break; // only the last assistant turn carries the current pills
	}
}

export async function resumeThread(threadId: string): Promise<void> {
	// Race-condition guard: if another resumeThread call starts, this one aborts
	const gen = ++_resumeGeneration;
	// Cancel previous in-flight requests
	_resumeController?.abort();
	const controller = new AbortController();
	_resumeController = controller;

	// Hydrate from per-thread local persistence FIRST so the UI doesn't
	// blink empty while the server fetch runs — and so we never end up
	// with an empty chat if the fetch is slow/failing.
	const localMessages = loadPersistedThread(threadId);
	messages = localMessages;
	sessionId = threadId;
	chatError = null;
	isStreaming = false;
	streamingActivity = 'idle';
	streamingToolName = null;
	streamingToolPhase = null;
	pendingPermission = null;
	pendingTabsPrompt = null;
	// Without this reset, a secret prompt persisted from thread A would
	// leak into the new visible PromptAnchor in thread B (newChat resets
	// it; resumeThread originally didn't because no surface rendered it
	// independently). See PR #236 review.
	pendingSecretPrompt = null;
	pendingMailConnect = null;
	pendingChangeset = null;
	changesetLoading = false;
	skipExtraction = false;
	// Restore any pending send-queue for this thread (durable across reload).
	messageQueue = loadPersistedQueue(threadId);
	// Restore the deferred-follow-ups tray for this thread (durable across reload).
	// Reconcile restored bubbles: a `queued` bubble with no matching live queue
	// entry (file-bearing — not persisted — or lost before the flush) is marked
	// `failed` so the user can re-send instead of staring at a pill that will
	// never go through.
	{
		const liveIds = new Set(messageQueue.map((q) => q.id));
		for (const m of messages) {
			if (m.queued && (m.queueId === undefined || !liveIds.has(m.queueId))) {
				m.queued = false;
				m.failed = true;
			}
		}
	}
	contextBudget = null;
	// Same reason as in `newChat()`: these are the LEFT thread's state. Without
	// them, switching into a thread that never compacted still showed its bar,
	// and a retry banner followed the user across threads.
	compactionOffer = null;
	// Thread-scoped: a count of what is waiting in the PREVIOUS conversation is exactly
	// the wrong thing to leave on screen. Re-fetched by `resumeThread` for the new one.
	threadPending = 0;
	retryStatus = null;
	runStartedAt = null;
	runPromptCount = 0;
	runInterrupted = null;
	clearContext();
	persistChatNow();

	// The thread's live run, captured from the messages endpoint (atomic with
	// the transcript) and consumed after checkPendingPrompt to re-attach.
	let resumeActiveRun: { runId: string; status: string; lastPersistedSeq: number } | null = null;
	// True only when we adopted the server transcript (not the kept-local copy);
	// the re-attach `since` aligns to the server transcript, so we re-attach only
	// in that case to avoid a local/server seq mismatch.
	let adoptedServer = false;

	try {
		// Create backend session from persisted thread
		const res = await fetch(`${getApiBase()}/sessions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ threadId }),
			signal: controller.signal,
		});
		if (gen !== _resumeGeneration) return; // superseded by newer click
		if (!res.ok) {
			// The server responded with an error status (not a dropped
			// connection) — opening the conversation failed. Don't blame the
			// user's internet; point at the recovery that actually works (a
			// reload uses the GET messages path, which sidesteps the resume
			// session-open). The fetch-rejected case (real connectivity loss)
			// still falls through to the catch → error_connection.
			chatError = t('chat.error_open_thread');
			return;
		}
		const data = (await res.json()) as { sessionId: string; model?: string; contextWindow?: number };
		sessionId = data.sessionId;
		if (data.model) { sessionModel = data.model; sessionTier = data.model; }
		if (data.contextWindow) contextWindow = data.contextWindow;

		// Load thread metadata (extraction flag). `threadId` can originate from a
		// notification deep-link (`/app?thread=…`), so encode it into the path —
		// consistent with the service worker, and defensive even though it's
		// same-origin + single-tenant.
		const encThreadId = encodeURIComponent(threadId);
		const threadRes = await fetch(`${getApiBase()}/threads/${encThreadId}`, {
			signal: controller.signal,
		});
		if (gen !== _resumeGeneration) return;
		if (threadRes.ok) {
			// thread is null for an old/missing thread (server now returns 200 +
			// threadMissing instead of 404) — guard before reading.
			const threadData = (await threadRes.json()) as { thread: { skip_extraction: number } | null };
			if (threadData.thread) skipExtraction = !!threadData.thread.skip_extraction;
		}

		// Load messages for display
		const msgRes = await fetch(`${getApiBase()}/threads/${encThreadId}/messages`, {
			signal: controller.signal,
		});
		if (gen !== _resumeGeneration) return; // superseded by newer click
		if (msgRes.ok) {
			// Server returns RenderedMessage[] — already shaped for the UI
			// (tool_result carriers merged into preceding tool_use, safety
			// wrappers stripped, blocks[] interleaved). Map 1:1, then strip
			// agent-synthesized empty user bubbles so they don't render.
			interface ServerRenderedMessage {
				role: string;
				content: string;
				blocks?: ContentBlock[];
				toolCalls?: ToolCallInfo[];
				usage?: UsageInfo;
				note?: { code: string; detail?: string };
				created_at?: string;
			}
			const msgData = (await msgRes.json()) as {
				messages: ServerRenderedMessage[];
				// Tier-2: the thread's live run, read atomically with the transcript
				// so `lastPersistedSeq` is exactly this transcript's durable boundary.
				activeRun?: { runId: string; status: string; lastPersistedSeq: number } | null;
				threadMissing?: boolean;
			};
			// Old/deleted thread (or a transient tenant-scope race): the server
			// returns 200 + threadMissing instead of a 404 (which would land as
			// browser console noise). Keep whatever local snapshot exists — a
			// stale copy is recoverable, a wipe is not — and skip silently. No
			// misleading connection error for a thread that's simply gone.
			if (msgData.threadMissing) return;
			resumeActiveRun = msgData.activeRun ?? null;
			const serverMessages: ChatMessage[] = dropEmptyUserMessages(
				msgData.messages.map((m) => {
					const cm: ChatMessage = {
						role: m.role === 'assistant' ? 'assistant' : 'user',
						content: m.content ?? '',
					};
					if (m.blocks && m.blocks.length > 0) cm.blocks = m.blocks;
					if (m.toolCalls && m.toolCalls.length > 0) cm.toolCalls = m.toolCalls;
					if (m.usage) cm.usage = m.usage;
					if (m.note) cm.note = m.note;
					if (m.created_at) cm.createdAt = m.created_at;
					return cm;
				}),
			);
			// Strip the raw follow-up trailer + re-derive the pills before rendering
			// the server transcript (see hydrateServerTranscript).
			hydrateServerTranscript(serverMessages);
			// Server is authoritative once it returns, BUT: a mid-persist
			// window can return fewer messages than the local snapshot
			// (classic case: user sent a turn, navigated to /app/artifacts
			// before the run finished, came back here). If the server has
			// strictly fewer messages than what we already have locally,
			// keep the local copy — it probably contains the in-flight
			// user turn that the server hasn't persisted yet. Equal-or-more
			// means the server caught up; use it.
			//
			// Exception: a SETTLED thread (no active run) with no unpersisted
			// local message (`failed`/`queued`) whose server transcript is merely
			// SHORTER — the projection legitimately collapsed it, e.g. the #4
			// multi-step-turn merge. Without this, a thread cached with the old
			// (longer, fragmented) shape would never adopt the merged transcript,
			// so the fix wouldn't reach already-viewed threads. `failed`/`queued`
			// rows are local-only + unrecoverable, so their presence keeps local.
			const hasUnpersistedLocal = localMessages.some((m) =>
				m.failed || m.queued || m.knowledgeWrites?.some((w) => w.status === 'pending_review'));
			// The shorter-transcript adoption must NOT fire while a turn is streaming: the
			// fetch above awaited a round-trip, and a turn sent in that window is in local
			// `messages` but not yet on the server (activeRun null, not failed/queued), so
			// adopting the shorter server list would wipe the in-flight user bubble +
			// placeholder. The `>=` path stays unguarded — a thread switch that legitimately
			// loads an equal-or-longer transcript is unaffected.
			if (serverMessages.length >= localMessages.length
				|| (!isStreaming && !resumeActiveRun && !hasUnpersistedLocal)) {
				// Server messages never carry chips — without this, adoption wipes a
				// pending-review chip at run end (the observed end-of-run flicker) and
				// loses it for good on a settled reload.
				carryKnowledgeWrites(localMessages, serverMessages);
				messages = serverMessages;
				adoptedServer = true;
				// DEF-dk-review-chip-resume-invisible: the carried chips cover what
				// LOCAL storage remembered, but a reload on another device (or after
				// the local cache dropped the thread) still started chip-less — the
				// amber review chip only lived in the SSE side-channel. Re-hydrate
				// this thread's PENDING queue entries as chips on the last message,
				// so the keep/edit/discard decision happens where the conversation
				// happened. Client-only display state; the wording never re-enters
				// model context (the store field is documentation-pinned to that).
				try {
					const qRes = await fetch(
						`${getApiBase()}/knowledge/queue?threadId=${encodeURIComponent(threadId)}`,
						{ signal: controller.signal },
					);
					if (gen !== _resumeGeneration) return;
					if (qRes.ok) {
						const qData = await qRes.json() as { entries?: unknown };
						// Guard again AFTER the body read: an abort between the header
						// and here lets the continuation run after a newer resume
						// started — without it, this thread's chips land on the
						// OTHER thread's transcript (review F3).
						if (gen !== _resumeGeneration) return;
						if (Array.isArray(qData.entries) && qData.entries.length > 0) {
							const chips = queueEntriesToChips(allKnowledgeWrites(messages), qData.entries);
							// Chips render ONLY on assistant messages (review F1): a
							// transcript ending on a user turn (interrupted run) must
							// anchor on the last ASSISTANT message, not messages[-1].
							const anchor = anchorKnowledgeChips(messages);
							if (chips.length > 0 && anchor) (anchor.knowledgeWrites ??= []).push(...chips);
						}
					}
				} catch {
					// Best-effort: the queue hub remains the authoritative surface.
				}
			}
		}

		persistChatNow();

		// Check for a pending prompt that survived a disconnect/refresh
		if (gen === _resumeGeneration) {
			await checkPendingPrompt();
		}

		// Re-attach to a live run (Tier 2): replay-then-tail the in-flight
		// activity so a reload mid-run keeps showing the agent working instead of
		// going blind. Only when we adopted the SERVER transcript — its
		// `lastPersistedSeq` aligns to that exact transcript, so the replay has no
		// gap and no double-render (AC2/AC3). An `interrupted` run (engine
		// restarted mid-run) gets a Retry banner instead — there is no resume.
		let reattaching = false;
		if (gen === _resumeGeneration && resumeActiveRun && adoptedServer) {
			if (resumeActiveRun.status === 'interrupted') {
				runInterrupted = { runId: resumeActiveRun.runId };
			} else if (
				(resumeActiveRun.status === 'running' || resumeActiveRun.status === 'awaiting_input') &&
				!isStreaming
			) {
				reattaching = true;
				void reattachRun(threadId, resumeActiveRun.runId, resumeActiveRun.lastPersistedSeq, gen);
			}
		}

		// Drain a restored send-queue: a turn typed while the previous session
		// streamed, then carried across a reload. Only when this resume is still
		// current, the thread is idle, there's no pending prompt blocking, and
		// we're not re-attaching to a live run (the queued turn drains after it).
		if (gen === _resumeGeneration && !isStreaming && !reattaching && !pendingChangeset && messageQueue.length > 0) {
			const next = messageQueue.shift()!;
			persistChatNow();
			setTimeout(() => { void _executeRun(next.task, next.files, undefined, next.runOptions, next.id); }, 100);
		}
		// The chip that announced any queued write in this thread is client-only and did not
		// survive the reload, so ask the server what is still waiting HERE.
		void refreshThreadPendingCount();
	} catch (err: unknown) {
		// Silently ignore abort errors from superseded requests
		if (err instanceof DOMException && err.name === 'AbortError') return;
		chatError = t('chat.error_connection');
	}
}

/**
 * Lightweight reconciliation: if there's an active thread and we're NOT
 * currently streaming, refetch the canonical message list from the server
 * and swap it in when it's at least as long as the local snapshot.
 *
 * Why this exists (F13, demo-walk hardening): when the user
 * navigates away from /app mid-stream (e.g. clicks Settings), ChatView
 * unmounts + the SSE listener is torn down. The engine finishes the run
 * server-side, persists the assistant message to history, and bills the
 * user — but the in-memory `messages` array still holds the empty
 * assistant placeholder from before the disconnect. On return to /app,
 * ChatView re-mounts against the stale store and the reader sees their
 * own prompt + an empty "AI" reply, even though History → expand run
 * shows the full response. Reads as "I got charged but no answer", the
 * exact HN-comment pattern we want to avoid on launch day.
 *
 * Distinct from `resumeThread`:
 *   - Doesn't reset activity / pending prompts / streaming flags
 *   - Doesn't create a new backend session
 *   - Bails out if a stream is in flight (the live stream is authoritative)
 *   - Same merge rule: only swap when server >= local (mid-persist guard)
 *
 * Safe to call on every ChatView mount — additive, no SSE-lifecycle change.
 */
export async function reconcileThread(): Promise<void> {
	const tid = sessionId;
	if (!tid) return;
	if (isStreaming) return;
	try {
		const res = await fetch(`${getApiBase()}/threads/${tid}/messages`);
		if (!res.ok) return;
		interface ServerRenderedMessage {
			role: string;
			content: string;
			blocks?: ContentBlock[];
			toolCalls?: ToolCallInfo[];
			usage?: UsageInfo;
			note?: { code: string; detail?: string };
			created_at?: string;
		}
		const data = (await res.json()) as {
			messages: ServerRenderedMessage[];
			activeRun?: { runId: string; status: string; lastPersistedSeq: number } | null;
			threadMissing?: boolean;
		};
		// Missing/old thread returns 200 + threadMissing — never overwrite the
		// local snapshot with the empty server transcript.
		if (data.threadMissing) return;
		const serverMessages: ChatMessage[] = dropEmptyUserMessages(
			data.messages.map((m) => {
				const cm: ChatMessage = {
					role: m.role === 'assistant' ? 'assistant' : 'user',
					content: m.content ?? '',
				};
				if (m.blocks && m.blocks.length > 0) cm.blocks = m.blocks;
				if (m.toolCalls && m.toolCalls.length > 0) cm.toolCalls = m.toolCalls;
				if (m.usage) cm.usage = m.usage;
				if (m.note) cm.note = m.note;
				if (m.created_at) cm.createdAt = m.created_at;
				return cm;
			}),
		);
		// Strip the raw follow-up trailer + re-derive pills, exactly as
		// resumeThread does — reconcile adopts the same server transcript and must
		// not leak the raw JSON / drop the pills when it swaps in a settled thread.
		hydrateServerTranscript(serverMessages);
		// Mirror resumeThread's mid-persist guard: only swap when the server
		// has caught up to the local snapshot. A shorter server list means a
		// turn is still being persisted; keep local until it lands.
		// AND only when the active thread hasn't changed since this fetch began
		// (`tid === sessionId`) — the same guard the activeRun re-attach below
		// already uses. Without it, a thread switch mid-fetch (a notification
		// deep-link `resumeThread`, or a manual click) would clobber the newly
		// opened thread's messages with the stale thread's server transcript.
		// Exception (mirrors resumeThread): a settled thread (no active run) with
		// no unpersisted local message adopts a merely-shorter server transcript
		// too, so a thread cached with the old fragmented shape picks up the #4
		// merged projection instead of staying stale forever.
		const hasUnpersistedLocal = messages.some((m) =>
			m.failed || m.queued || m.knowledgeWrites?.some((w) => w.status === 'pending_review'));
		let adopted = false;
		// RE-CHECK isStreaming HERE, not just at entry: the fetch above awaited a full
		// round-trip, during which the user may have sent a turn (tapped a follow-up pill
		// on remount). That turn is in local `messages` + streaming, but the server does
		// not know its run yet (activeRun null) and it is not failed/queued — so the
		// `(!data.activeRun && !hasUnpersistedLocal)` disjunct would adopt the shorter
		// server transcript and WIPE the just-sent user bubble + streaming placeholder.
		// Never adopt while a turn is in flight.
		if (tid === sessionId && !isStreaming
			&& (serverMessages.length >= messages.length || (!data.activeRun && !hasUnpersistedLocal))) {
			// Same carry-over as resumeThread — a reconcile on remount must not wipe
			// a pending-review chip either.
			carryKnowledgeWrites(messages, serverMessages);
			messages = serverMessages;
			adopted = true;
			persistChatNow();
		}
		// A remount that lands here (rather than the full resumeThread path) must
		// also re-attach a live run, else the user stays blind to in-flight
		// activity until a full thread-switch. Same guards as resumeThread: only
		// on the adopted server transcript, not already streaming/re-attached.
		if (adopted && data.activeRun && tid === sessionId) {
			if (data.activeRun.status === 'interrupted') {
				runInterrupted = { runId: data.activeRun.runId };
			} else if (
				(data.activeRun.status === 'running' || data.activeRun.status === 'awaiting_input') &&
				!isStreaming && !isReattached
			) {
				void reattachRun(tid, data.activeRun.runId, data.activeRun.lastPersistedSeq, _resumeGeneration);
			}
		}
	} catch {
		// Network hiccup is non-fatal — the local snapshot is still readable
		// and the next user action (send / explicit resumeThread) will reconcile.
	}
}

