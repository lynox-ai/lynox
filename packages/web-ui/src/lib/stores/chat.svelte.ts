import { getApiBase } from '../config.svelte.js';
import { cpSuppliesLLMKey } from '../utils/billing-tier.js';
import { estimateCost } from '../format.js';
import { t } from '../i18n.svelte.js';
import { mergeDoneUsage, type UsageInfo } from './chat-usage.js';
import { setContext, clearContext } from './context-panel.svelte.js';
import { loadThreads } from './threads.svelte.js';
import { addToast } from './toast.svelte.js';
import { suppressSessionExpiredBanner } from './session.svelte.js';
import { selectPendingPromptHead } from '../utils/pipeline-status.js';

// Re-export the canonical UsageInfo + helpers from the pure module so existing
// `import { UsageInfo } from './chat.svelte.js'` callers keep working.
export { usageFromDoneEvent } from './chat-usage.js';
export type { UsageInfo } from './chat-usage.js';

// ---------------------------------------------------------------------------
// Follow-up parsing (<follow_ups>…</follow_ups> block extraction)
// ---------------------------------------------------------------------------

const FOLLOW_UP_RE = /<follow_ups>\s*([\s\S]*?)\s*<\/follow_ups>/;
const MAX_FOLLOW_UPS = 4;
const MAX_LABEL_LENGTH = 40;

/** Resolved once per module load — the user's tz doesn't change mid-tab. Server falls back to UTC if `''`. */
const USER_TIMEZONE: string = (() => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
	} catch {
		return '';
	}
})();

function parseFollowUps(text: string): { suggestions: FollowUpSuggestion[]; cleanText: string } {
	const match = FOLLOW_UP_RE.exec(text);
	if (!match) return { suggestions: [], cleanText: text };

	const cleanText = text.replace(FOLLOW_UP_RE, '').trimEnd();
	let suggestions: FollowUpSuggestion[] = [];

	try {
		const parsed: unknown = JSON.parse(match[1]!);
		if (!Array.isArray(parsed)) return { suggestions: [], cleanText };

		for (const item of parsed) {
			if (typeof item !== 'object' || item === null) continue;
			const obj = item as Record<string, unknown>;
			if (typeof obj['label'] !== 'string' || typeof obj['task'] !== 'string') continue;
			if (!obj['label'].trim() || !obj['task'].trim()) continue;
			suggestions.push({
				label: obj['label'].trim().slice(0, MAX_LABEL_LENGTH),
				task: obj['task'].trim(),
			});
		}
	} catch {
		return { suggestions: [], cleanText };
	}

	// Deduplicate by label
	const seen = new Set<string>();
	suggestions = suggestions.filter(s => {
		if (seen.has(s.label)) return false;
		seen.add(s.label);
		return true;
	});

	return { suggestions: suggestions.slice(0, MAX_FOLLOW_UPS), cleanText };
}

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

export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'thinking'; text: string }
	| { type: 'tool_call'; index: number };

export interface FollowUpSuggestion {
	label: string;
	task: string;
}

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	toolCalls?: ToolCallInfo[];
	/** Ordered blocks for interleaved rendering (text ↔ tool calls) */
	blocks?: ContentBlock[];
	pipeline?: PipelineInfo;
	/** Sub-agent delegation progress (set when spawn_agent fires). */
	spawn?: SpawnProgress;
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
	/** Agent-generated follow-up suggestions (parsed from <follow_ups> block) */
	followUps?: FollowUpSuggestion[];
	/** Set on a synthetic marker bubble inserted when the engine auto-compacts
	 *  the conversation — renders as an inline "conversation compacted" divider. */
	compactionNote?: { previousPercent: number };
	/** B-full: a display-only failure note persisted for a failed turn. The
	 *  engine sends a structured code (not prose) so the UI renders a localized
	 *  banner; `detail` is a sanitized provider-error snippet. Present only on
	 *  rows the render projection flagged as notes (reload path). */
	note?: { code: string; detail?: string };
	/** @internal — tracks whether a tool call happened between text segments */
	_toolSinceText?: boolean;
}

export interface SpawnProgress {
	/** All sub-agents spawned in this delegation. */
	agents: string[];
	/** Sub-agents currently running. */
	running: string[];
	/** Sub-agents that have completed, with outcome. */
	done: Array<{ name: string; ok: boolean; elapsedS: number }>;
	/** Last-seen tool name per sub-agent. */
	lastToolBySub: Record<string, string>;
	/** Seconds since the delegation started. */
	elapsedS: number;
	/** Client timestamp when the spawn started (for fallback elapsed if no heartbeat). */
	startedAt: number;
}

export interface ToolCallInfo {
	name: string;
	input: unknown;
	result?: string;
	status: 'running' | 'done' | 'error';
}

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

export interface PermissionPrompt {
	question: string;
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
	}
	writePersistedRoot(root);
}

export interface ContextBudget {
	totalTokens: number;
	maxTokens: number;
	usagePercent: number;
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
let pendingSecretPrompt = $state<{ name: string; prompt: string; keyType?: string; promptId?: string } | null>(null);
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
let isOffline = $state(typeof navigator !== 'undefined' ? !navigator.onLine : false);

// Offline detection + auto-retry on reconnect
if (typeof window !== 'undefined') {
	window.addEventListener('offline', () => { isOffline = true; });
	window.addEventListener('online', () => {
		isOffline = false;
		// Auto-retry the last failed message
		const lastFailed = [...messages].reverse().find((m) => m.role === 'user' && m.failed);
		if (lastFailed && !isStreaming) {
			lastFailed.failed = false;
			lastFailed.queued = true;
			lastFailed.queueId = newQueueId();
			messageQueue.push({ id: lastFailed.queueId, task: lastFailed.content });
			chatError = null;
			// Small delay to let network stabilize
			setTimeout(() => {
				if (messageQueue.length > 0) {
					const next = messageQueue.shift()!;
					void _executeRun(next.task, next.files, undefined, next.runOptions, next.id);
				}
			}, 500);
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
async function ensureSession(resumeThreadId?: string | null): Promise<string> {
	if (sessionId) return sessionId;
	// Fire the hosting-tier probe alongside session creation — by the time
	// any LLM error surfaces, the tier is known and error copy branches
	// correctly.
	void probeManagedTier();
	const init: RequestInit = resumeThreadId
		? {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ threadId: resumeThreadId }),
		}
		: { method: 'POST' };
	const res = await fetch(`${getApiBase()}/sessions`, init);
	if (res.status === 401) throw new SessionExpiredError();
	const data = (await res.json()) as { sessionId: string; model?: string; contextWindow?: number };
	sessionId = data.sessionId;
	if (data.model) sessionModel = data.model;
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
		messages.push({ role: 'user', content: fileNames ? `${display}\n📎 ${fileNames}` : display, queued: true, queueId: id });
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
		messages.push({ role: 'user', content: fileNames ? `${display}\n📎 ${fileNames}` : display });
		userMsgIdx = messages.length - 1;
	}

	const assistantIdx = messages.length;
	messages.push({ role: 'assistant', content: '', toolCalls: [] });

	// Claim ownership of the shared streaming state so an in-flight re-attach
	// that ends mid-send can't switch off this run's activity indicators.
	streamEpoch++;
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
		if (pendingPermission || pendingSecretPrompt || pendingTabsPrompt || pendingMailConnect) {
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
						handleSSEEvent(eventType, data, assistantIdx, userMsgIdx);
						if (eventSeq > 0) lastAppliedSeq = eventSeq;
					} catch { /* skip malformed SSE events */ }
					eventType = '';
					eventSeq = 0;
				}
			}
		}
	} catch {
		// SSE connection error — retry once if not already retried
		if (!retried) {
			retried = true;
			try {
				await new Promise(r => setTimeout(r, 2000));
				const retryRes = await fetch(`${getApiBase()}/sessions/${sid}/run`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload)
				});
				if (retryRes.ok && retryRes.body) {
					const retryReader = retryRes.body.getReader();
					const retryDecoder = new TextDecoder();
					let retryBuffer = '';
					while (true) {
						const { done, value } = await retryReader.read();
						if (done) break;
						retryBuffer += retryDecoder.decode(value, { stream: true });
						const retryLines = retryBuffer.split('\n');
						retryBuffer = retryLines.pop() ?? '';
						let retryEventType = '';
						for (const line of retryLines) {
							if (line.startsWith('event: ')) retryEventType = line.slice(7);
							else if (line.startsWith('data: ') && retryEventType) {
								try { handleSSEEvent(retryEventType, JSON.parse(line.slice(6)) as Record<string, unknown>, assistantIdx, userMsgIdx); } catch { /* skip */ }
								retryEventType = '';
							}
						}
					}
					try { retryReader.cancel(); } catch { /* already closed */ }
				} else {
					throw new Error('Retry failed');
				}
			} catch {
				chatError = t('chat.error_connection');
				chatErrorDetail = null;
				if (messages[assistantIdx] && !messages[assistantIdx]!.content) messages.splice(assistantIdx, 1);
				if (messages[userMsgIdx]) messages[userMsgIdx]!.failed = true;
			}
		} else {
			chatError = t('chat.error_connection');
			chatErrorDetail = null;
			if (messages[assistantIdx] && !messages[assistantIdx]!.content) messages.splice(assistantIdx, 1);
			if (messages[userMsgIdx]) messages[userMsgIdx]!.failed = true;
		}
	} finally {
		try { reader.cancel(); } catch { /* already closed */ }
	}

	isStreaming = false;
	streamingActivity = 'idle';
	streamingToolName = null;
	streamingToolPhase = null;
	pendingPermission = null;
	pendingTabsPrompt = null;
	retryStatus = null;

	// Parse follow-up suggestions from assistant response
	const lastMsg = messages[assistantIdx];
	if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
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

function handleSSEEvent(type: string, data: Record<string, unknown>, idx: number, userIdx: number): void {
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
			msg.toolCalls = msg.toolCalls ?? [];
			// Dedup: skip if last tool call has same name and is still running
			const lastTc = msg.toolCalls[msg.toolCalls.length - 1];
			if (!(lastTc && lastTc.name === toolName && lastTc.status === 'running'
				&& JSON.stringify(lastTc.input) === JSON.stringify(toolInput))) {
				const tcIndex = msg.toolCalls.length;
				msg.toolCalls.push({ name: toolName, input: toolInput, status: 'running' });
				// Interleaved blocks: add tool_call block in order. If the previous
				// block was text, that text just became "complete" — emit it so
				// auto-speak can start playing it without waiting for turn_end.
				msg.blocks = msg.blocks ?? [];
				const prevBlock = msg.blocks[msg.blocks.length - 1];
				if (prevBlock && prevBlock.type === 'text') {
					emitCompletedTextBlock(prevBlock.text, `msg-${idx}-block-${msg.blocks.length - 1}`);
				}
				msg.blocks.push({ type: 'tool_call', index: tcIndex });
			}
			msg._toolSinceText = true;
			streamingActivity = 'tool';
			streamingToolName = toolName;
			streamingToolPhase = null;
			currentToolStartedAt = Date.now();
			// Skip sidebar update for tools whose dedicated stream event carries
			// richer live state. spawn_agent emits a separate 'spawn' event a
			// few ticks later with running/done counts; letting the tool_call
			// path set tool+spawn_agent first causes a visible flash to the
			// generic tool card before the spawn view takes over.
			if (toolName !== 'ask_user' && toolName !== 'ask_secret' && toolName !== 'spawn_agent') {
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
			const tc = msg.toolCalls?.find((t) => t.name === toolName && t.status === 'running')
				?? msg.toolCalls?.findLast((t) => t.name === toolName);
			if (tc) {
				tc.result = String(data['result'] ?? '');
				tc.status = data['isError'] === true ? 'error' : 'done';
				setContext({
					type: tc.name === 'write_file' ? 'file' : 'tool',
					toolName: tc.name,
					toolInput: tc.input,
					toolResult: tc.result,
					filePath: tc.name === 'write_file' ? String((tc.input as Record<string, unknown>)?.['path'] ?? '') : undefined,
					title: tc.name,
				});
				persistChat();
			}
			streamingToolPhase = null;
			break;
		}
		case 'spawn': {
			// Delegation started. Track progress so the UI can show which
			// sub-agents are running, elapsed time, and last tool per sub.
			const agents = (data['agents'] as string[] | undefined) ?? [];
			msg.spawn = {
				agents,
				running: [...agents],
				done: [],
				lastToolBySub: {},
				elapsedS: 0,
				startedAt: Date.now(),
			};
			streamingActivity = 'tool';
			streamingToolName = 'spawn_agent';
			currentToolStartedAt = Date.now();
			// Surface delegation in the Context panel so the sidebar shows
			// live sub-agent state alongside the inline ChatView block.
			setContext({
				type: 'spawn',
				title: 'spawn_agent',
				spawnAgents: agents,
				spawnRunning: [...agents],
				spawnDone: [],
				spawnLastTool: {},
				spawnElapsedS: 0,
			});
			break;
		}
		case 'spawn_progress': {
			if (!msg.spawn) break;
			msg.spawn.elapsedS = Number(data['elapsedS'] ?? 0);
			msg.spawn.running = (data['running'] as string[] | undefined) ?? msg.spawn.running;
			msg.spawn.lastToolBySub = (data['lastToolBySub'] as Record<string, string> | undefined) ?? msg.spawn.lastToolBySub;
			// Keep the Context-panel in sync; done list carries over since
			// progress events don't re-emit it.
			setContext({
				type: 'spawn',
				title: 'spawn_agent',
				spawnAgents: msg.spawn.agents,
				spawnRunning: [...msg.spawn.running],
				spawnDone: [...msg.spawn.done],
				spawnLastTool: { ...msg.spawn.lastToolBySub },
				spawnElapsedS: msg.spawn.elapsedS,
			});
			break;
		}
		case 'spawn_child_done': {
			if (!msg.spawn) break;
			const sub = String(data['subAgent'] ?? '');
			const ok = data['ok'] === true;
			const elapsedS = Number(data['elapsedS'] ?? 0);
			msg.spawn.running = msg.spawn.running.filter(a => a !== sub);
			msg.spawn.done = [...msg.spawn.done, { name: sub, ok, elapsedS }];
			setContext({
				type: 'spawn',
				title: 'spawn_agent',
				spawnAgents: msg.spawn.agents,
				spawnRunning: [...msg.spawn.running],
				spawnDone: [...msg.spawn.done],
				spawnLastTool: { ...msg.spawn.lastToolBySub },
				spawnElapsedS: msg.spawn.elapsedS,
			});
			break;
		}
		case 'prompt':
			if (!pendingPermission) runPromptCount++;
			pendingPermission = {
				question: String(data['question'] ?? ''),
				options: data['options'] as string[] | undefined,
				timeoutMs: data['timeoutMs'] as number | undefined,
				receivedAt: Date.now(),
				promptId: data['promptId'] as string | undefined,
				multiSelect: data['multi_select'] === true,
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
			if (total != null && max != null && pct != null) {
				contextBudget = { totalTokens: total, maxTokens: max, usagePercent: pct };
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
			// Remove empty assistant message and mark user message as failed
			if (messages[idx] && !messages[idx]!.content) messages.splice(idx, 1);
			if (messages[userIdx]) messages[userIdx]!.failed = true;
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
		if (promptType === 'ask_user' && kind === 'tabs' && Array.isArray(data['questions'])) {
			pendingTabsPrompt = {
				promptId: String(data['promptId'] ?? ''),
				questions: data['questions'] as TabsPromptQuestion[],
				partialAnswers: Array.isArray(data['partialAnswers']) ? (data['partialAnswers'] as (string | null)[]) : undefined,
				timeoutMs: data['timeoutMs'] as number | undefined,
				receivedAt: Date.now(),
			};
		} else if (promptType === 'ask_user') {
			pendingPermission = {
				question: String(data['question'] ?? ''),
				options: data['options'] as string[] | undefined,
				timeoutMs: data['timeoutMs'] as number | undefined,
				receivedAt: Date.now(),
				promptId: data['promptId'] as string | undefined,
				// Restore multi-select pills on reconnect (v33) — without this the
				// prompt degraded to single-select after a reload mid-prompt.
				multiSelect: data['multiSelect'] === true,
			};
		} else if (promptType === 'ask_secret') {
			pendingSecretPrompt = {
				name: String(data['secretName'] ?? ''),
				prompt: String(data['question'] ?? ''),
				keyType: data['secretKeyType'] as string | undefined,
				promptId: data['promptId'] as string | undefined,
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

export function getMessages() {
	return messages;
}
/** Add a temporary placeholder message (e.g. voice transcription bubble). Returns its index. */
export function pushPlaceholder(content: string): number {
	const idx = messages.length;
	messages.push({ role: 'user', content });
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
	messageQueue = [];
	sessionModel = null;
	contextBudget = null;
	runStartedAt = null;
	runPromptCount = 0;
	clearContext();
	persistChatNow();
}

export function getSessionId() {
	return sessionId;
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
			void fetchChangeset();
		}
		persistChat();
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
		if (data.model) sessionModel = data.model;
		if (data.contextWindow) contextWindow = data.contextWindow;

		// Load thread metadata (extraction flag)
		const threadRes = await fetch(`${getApiBase()}/threads/${threadId}`, {
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
		const msgRes = await fetch(`${getApiBase()}/threads/${threadId}/messages`, {
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
					return cm;
				}),
			);
			// Server is authoritative once it returns, BUT: a mid-persist
			// window can return fewer messages than the local snapshot
			// (classic case: user sent a turn, navigated to /app/artifacts
			// before the run finished, came back here). If the server has
			// strictly fewer messages than what we already have locally,
			// keep the local copy — it probably contains the in-flight
			// user turn that the server hasn't persisted yet. Equal-or-more
			// means the server caught up; use it.
			if (serverMessages.length >= localMessages.length) {
				messages = serverMessages;
				adoptedServer = true;
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
 * Why this exists (F13, rafael HN-launch QA 2026-05-27): when the user
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
				return cm;
			}),
		);
		// Mirror resumeThread's mid-persist guard: only swap when the server
		// has caught up to the local snapshot. A shorter server list means a
		// turn is still being persisted; keep local until it lands.
		let adopted = false;
		if (serverMessages.length >= messages.length) {
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

