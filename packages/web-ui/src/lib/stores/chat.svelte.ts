import { getApiBase } from '../config.svelte.js';
import { estimateCost } from '../format.js';
import { t } from '../i18n.svelte.js';
import { setContext, clearContext } from './context-panel.svelte.js';
import { loadThreads } from './threads.svelte.js';
import { addToast } from './toast.svelte.js';

// ---------------------------------------------------------------------------
// Follow-up parsing (mirrors core telegram-formatter logic)
// ---------------------------------------------------------------------------

const FOLLOW_UP_RE = /<follow_ups>\s*([\s\S]*?)\s*<\/follow_ups>/;
const MAX_FOLLOW_UPS = 4;
const MAX_LABEL_LENGTH = 40;

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

export interface UsageInfo {
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

export type ContentBlock =
	| { type: 'text'; text: string }
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
	queued?: boolean;
	/** Stable id correlating this bubble with its `messageQueue` entry. Set
	 *  while queued, kept after un-queue (cheap) so removeQueuedMessage can
	 *  always identify which queue entry a bubble belongs to. */
	queueId?: string;
	/** Message failed to send (API error, connection lost, etc.) */
	failed?: boolean;
	/** Agent-generated follow-up suggestions (parsed from <follow_ups> block) */
	followUps?: FollowUpSuggestion[];
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
		};
	} catch { /* corrupt data */ }
	return { sessionId: null, threads: {} };
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
	if (threadId in root.threads) {
		delete root.threads[threadId];
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
let pendingPermission = $state<PermissionPrompt | null>(null);
let pendingTabsPrompt = $state<TabsPrompt | null>(null);
let pendingSecretPrompt = $state<{ name: string; prompt: string; keyType?: string; promptId?: string } | null>(null);
let secretPromptGeneration = $state(0);
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
	return managedTier === 'managed' || managedTier === 'managed_pro' || managedTier === 'eu';
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
					void _executeRun(next.task, next.files, undefined, undefined, next.id);
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

async function ensureSession(): Promise<string> {
	if (sessionId) return sessionId;
	// Fire the hosting-tier probe alongside session creation — by the time
	// any LLM error surfaces, the tier is known and error copy branches
	// correctly.
	void probeManagedTier();
	const res = await fetch(`${getApiBase()}/sessions`, { method: 'POST' });
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
	chatError = t('chat.error_session_expired');
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
		messageQueue.push({ id, task, files });
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

	isStreaming = true;

	const payload: Record<string, unknown> = { task, protocol: 2 };
	if (files && files.length > 0) {
		payload['files'] = files;
	}
	if (runOptions?.effort) payload['effort'] = runOptions.effort;
	if (runOptions?.thinking) payload['thinking'] = runOptions.thinking;

	let res = await fetch(`${getApiBase()}/sessions/${sid}/run`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});

	// Session record missing (e.g. after container restart) — recreate and retry.
	// Distinct from 401 (cookie-level auth failure) which is handled below.
	if (res.status === 404) {
		sessionId = null;
		try {
			sid = await ensureSession();
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
			return;
		}

		if (messages[userMsgIdx]) messages[userMsgIdx]!.queued = false;
	}

	if (!res.ok || !res.body) {
		isStreaming = false;
	streamingActivity = 'idle';
	streamingToolName = null;
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

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			let eventType = '';
			for (const line of lines) {
				if (line.startsWith('event: ')) {
					eventType = line.slice(7);
				} else if (line.startsWith('data: ') && eventType) {
					try {
						const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
						handleSSEEvent(eventType, data, assistantIdx, userMsgIdx);
					} catch { /* skip malformed SSE events */ }
					eventType = '';
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

	// Process queue: send next queued message
	if (messageQueue.length > 0) {
		const next = messageQueue.shift()!;
		// Small delay so the UI updates before next run starts
		setTimeout(() => { void _executeRun(next.task, next.files, undefined, undefined, next.id); }, 100);
	}
}

function handleSSEEvent(type: string, data: Record<string, unknown>, idx: number, userIdx: number): void {
	const msg = messages[idx];
	if (!msg) return;

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
		case 'thinking':
			msg.thinking = (msg.thinking ?? '') + String(data['thinking'] ?? '');
			streamingActivity = 'thinking';
			streamingToolName = null;
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
			pendingPermission = {
				question: String(data['question'] ?? ''),
				options: data['options'] as string[] | undefined,
				timeoutMs: data['timeoutMs'] as number | undefined,
				receivedAt: Date.now(),
				promptId: data['promptId'] as string | undefined,
			};
			break;
		case 'prompt_tabs': {
			const questions = Array.isArray(data['questions']) ? (data['questions'] as TabsPromptQuestion[]) : [];
			const promptId = typeof data['promptId'] === 'string' ? data['promptId'] : '';
			if (!promptId || questions.length === 0) break; // malformed, ignore
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
			break;
		}
		case 'secret_prompt':
			pendingSecretPrompt = {
				name: String(data['name'] ?? ''),
				prompt: String(data['prompt'] ?? ''),
				keyType: data['key_type'] as string | undefined,
				promptId: data['promptId'] as string | undefined,
			};
			// Reset UI state for fresh prompt (handles retry after cancel)
			secretPromptGeneration++;
			break;
		case 'turn_end': {
			retryStatus = null;
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
				msg.usage = {
					tokensIn: (prev?.tokensIn ?? 0) + inTok,
					tokensOut: (prev?.tokensOut ?? 0) + outTok,
					cacheRead: (prev?.cacheRead ?? 0) + cacheRead,
					cacheWrite: (prev?.cacheWrite ?? 0) + cacheWrite,
					costUsd: (prev?.costUsd ?? 0) + costUsd,
				};
				// Update context estimate (input tokens ≈ current context usage)
				if (!contextBudget || inTok > (contextBudget.totalTokens ?? 0)) {
					const pct = Math.round(inTok / contextWindow * 100);
					contextBudget = { totalTokens: inTok, maxTokens: contextWindow, usagePercent: pct };
				}
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
			break;
		}
		case 'pipeline_progress': {
			const stepId = String(data['stepId'] ?? '');
			const rawStatus = String(data['status'] ?? '');
			// Engine sends 'started', UI uses 'running'
			const status = (rawStatus === 'started' ? 'running' : rawStatus) as PipelineStepInfo['status'];
			const elapsed = data['elapsed'] as number | undefined;
			const durationMs = data['durationMs'] as number | undefined;

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
			break;
		}
		case 'done':
			// Budget threshold check — usage dashboard Phase 4. Dynamic import
			// keeps the alerts code out of the initial chat-store bundle for
			// cases where the user never completes a run. Fire-and-forget:
			// the alert is supplemental and must never interact with the run
			// lifecycle on failure.
			import('./usage-alerts.svelte.js')
				.then(m => m.checkUsageThreshold())
				.catch(() => { /* ignore — alerting is best-effort */ });
			break;
		case 'retry': {
			const attempt = data['attempt'] as number;
			const maxAttempts = data['maxAttempts'] as number;
			retryStatus = { attempt, maxAttempts };
			break;
		}
		case 'error': {
			retryStatus = null;
			// Agent sends { message: '...' }, http-api catch sends { error: '...' }
			const rawErr = String(data['error'] ?? data['message'] ?? 'Unknown error');
			chatErrorDetail = rawErr;
			chatError = mapApiError(0, rawErr);
			// Remove empty assistant message and mark user message as failed
			if (messages[idx] && !messages[idx]!.content) messages.splice(idx, 1);
			if (messages[userIdx]) messages[userIdx]!.failed = true;
			break;
		}
		case 'changeset_ready':
			void fetchChangeset();
			break;
		case 'context_compacted': {
			const prevPct = data['previousUsagePercent'] as number | undefined;
			contextBudget = null;
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

export async function submitSecret(name: string, value: string): Promise<boolean> {
	if (!sessionId || !pendingSecretPrompt) return false;
	const sid = sessionId;
	const promptId = pendingSecretPrompt.promptId;
	try {
		// Store secret directly in vault (bypasses chat — value never enters SSE/messages)
		const vaultRes = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ value }),
		});
		if (!vaultRes.ok) {
			// Vault write failed — don't tell engine it was saved
			pendingSecretPrompt = null;
			await fetch(`${getApiBase()}/sessions/${sid}/secret-saved`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ saved: false, promptId }),
			});
			return false;
		}
		// Notify engine that secret was saved
		pendingSecretPrompt = null;
		await fetch(`${getApiBase()}/sessions/${sid}/secret-saved`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ saved: true, promptId }),
		});
		return true;
	} catch {
		pendingSecretPrompt = null;
		return false;
	}
}

export async function cancelSecret(): Promise<void> {
	if (!sessionId || !pendingSecretPrompt) return;
	const promptId = pendingSecretPrompt.promptId;
	pendingSecretPrompt = null;
	await fetch(`${getApiBase()}/sessions/${sessionId}/secret-saved`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ saved: false, promptId }),
	});
}

export function getPendingSecretPrompt() {
	return pendingSecretPrompt;
}

export function getSecretPromptGeneration() {
	return secretPromptGeneration;
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
			};
		} else if (promptType === 'ask_secret') {
			pendingSecretPrompt = {
				name: String(data['secretName'] ?? ''),
				prompt: String(data['question'] ?? ''),
				keyType: data['secretKeyType'] as string | undefined,
				promptId: data['promptId'] as string | undefined,
			};
			secretPromptGeneration++;
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
		if (!res.ok) {
			const detail = await res.text().catch(() => `HTTP ${res.status}`);
			return { ok: false, error: detail };
		}
		const data = await res.json() as { ok: boolean; summary: string };
		// Reset local state so the UI reflects the compacted server-side view.
		contextBudget = null;
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
	pendingPermission = null;
	pendingTabsPrompt = null;
	pendingSecretPrompt = null;
	pendingChangeset = null;
	changesetLoading = false;
	skipExtraction = false;
	chatError = null;
	messageQueue = [];
	sessionModel = null;
	contextBudget = null;
	clearContext();
	persistChatNow();
}

export function getSessionId() {
	return sessionId;
}

let _resumeGeneration = 0;
let _resumeController: AbortController | null = null;

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
	pendingPermission = null;
	pendingTabsPrompt = null;
	pendingChangeset = null;
	changesetLoading = false;
	skipExtraction = false;
	messageQueue = [];
	contextBudget = null;
	clearContext();
	persistChatNow();

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
			chatError = t('chat.error_connection');
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
			const threadData = (await threadRes.json()) as { thread: { skip_extraction: number } };
			skipExtraction = !!threadData.thread.skip_extraction;
		}

		// Load messages for display
		const msgRes = await fetch(`${getApiBase()}/threads/${threadId}/messages`, {
			signal: controller.signal,
		});
		if (gen !== _resumeGeneration) return; // superseded by newer click
		// Server says "thread doesn't exist" — authoritative empty. Drop
		// the local snapshot so a later resume can't false-resurrect it
		// (happens when a thread was deleted elsewhere or on another device).
		if (msgRes.status === 404) {
			messages = [];
			dropPersistedThread(threadId);
			sessionId = null;
			chatError = t('chat.error_connection');
			return;
		}
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
			}
			const msgData = (await msgRes.json()) as { messages: ServerRenderedMessage[] };
			const serverMessages: ChatMessage[] = dropEmptyUserMessages(
				msgData.messages.map((m) => {
					const cm: ChatMessage = {
						role: m.role === 'assistant' ? 'assistant' : 'user',
						content: m.content ?? '',
					};
					if (m.blocks && m.blocks.length > 0) cm.blocks = m.blocks;
					if (m.toolCalls && m.toolCalls.length > 0) cm.toolCalls = m.toolCalls;
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
			}
		}

		persistChatNow();

		// Check for a pending prompt that survived a disconnect/refresh
		if (gen === _resumeGeneration) {
			await checkPendingPrompt();
		}
	} catch (err: unknown) {
		// Silently ignore abort errors from superseded requests
		if (err instanceof DOMException && err.name === 'AbortError') return;
		chatError = t('chat.error_connection');
	}
}

