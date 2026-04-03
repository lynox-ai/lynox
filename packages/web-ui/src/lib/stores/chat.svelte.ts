import { getApiBase } from '../config.svelte.js';
import { estimateCost } from '../format.js';
import { t } from '../i18n.svelte.js';
import { setContext, clearContext } from './context-panel.svelte.js';
import { loadThreads } from './threads.svelte.js';
import { addToast } from './toast.svelte.js';

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

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	toolCalls?: ToolCallInfo[];
	/** Ordered blocks for interleaved rendering (text ↔ tool calls) */
	blocks?: ContentBlock[];
	pipeline?: PipelineInfo;
	thinking?: string;
	usage?: UsageInfo;
	queued?: boolean;
	/** Message failed to send (API error, connection lost, etc.) */
	failed?: boolean;
	/** @internal — tracks whether a tool call happened between text segments */
	_toolSinceText?: boolean;
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

interface QueuedMessage {
	task: string;
	files?: FileAttachment[];
}

// Restore from localStorage
function loadPersistedChat(): { messages: ChatMessage[]; sessionId: string | null } {
	if (typeof localStorage === 'undefined') return { messages: [], sessionId: null };
	try {
		const saved = localStorage.getItem('lynox-chat');
		if (saved) {
			const data = JSON.parse(saved) as { messages?: ChatMessage[]; sessionId?: string };
			return { messages: data.messages ?? [], sessionId: data.sessionId ?? null };
		}
	} catch { /* corrupt data */ }
	return { messages: [], sessionId: null };
}

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function persistChat(): void {
	if (typeof localStorage === 'undefined') return;
	// Debounce: collapse rapid writes (e.g. during streaming) into one
	if (_persistTimer) clearTimeout(_persistTimer);
	_persistTimer = setTimeout(() => {
		_persistTimer = null;
		try {
			localStorage.setItem('lynox-chat', JSON.stringify({ messages, sessionId }));
		} catch { /* quota exceeded */ }
	}, 500);
}

/** Flush pending persist immediately (e.g. on newChat or page unload). */
function persistChatNow(): void {
	if (_persistTimer) {
		clearTimeout(_persistTimer);
		_persistTimer = null;
	}
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem('lynox-chat', JSON.stringify({ messages, sessionId }));
	} catch { /* quota exceeded */ }
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
let pendingPermission = $state<PermissionPrompt | null>(null);
let pendingSecretPrompt = $state<{ name: string; prompt: string; keyType?: string; promptId?: string } | null>(null);
let secretPromptGeneration = $state(0);
let chatError = $state<string | null>(null);
let chatErrorDetail = $state<string | null>(null);
let authError = $state(false);
let messageQueue = $state<QueuedMessage[]>([]);
let sessionModel = $state<string | null>(null);
let contextWindow = $state<number>(200_000);
let contextBudget = $state<ContextBudget | null>(null);
let pendingChangeset = $state<ChangesetFileInfo[] | null>(null);
let changesetLoading = $state(false);
let retryStatus = $state<{ attempt: number; maxAttempts: number } | null>(null);
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
			messageQueue.push({ task: lastFailed.content });
			chatError = null;
			// Small delay to let network stabilize
			setTimeout(() => {
				if (messageQueue.length > 0) {
					const next = messageQueue.shift()!;
					void _executeRun(next.task, next.files);
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
	const res = await fetch(`${getApiBase()}/sessions`, { method: 'POST' });
	const data = (await res.json()) as { sessionId: string; model?: string; contextWindow?: number };
	sessionId = data.sessionId;
	if (data.model) sessionModel = data.model;
	if (data.contextWindow) contextWindow = data.contextWindow;
	return sessionId;
}

export interface FileAttachment {
	name: string;
	type: string;
	data: string; // base64
}

export async function sendMessage(task: string, files?: FileAttachment[]): Promise<void> {
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
		const fileNames = files?.map((f) => f.name).join(', ');
		messages.push({ role: 'user', content: fileNames ? `${task}\n📎 ${fileNames}` : task, queued: true });
		messageQueue.push({ task, files });
		return;
	}

	await _executeRun(task, files);
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
		return t('chat.error_insufficient_quota');
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

async function _executeRun(task: string, files?: FileAttachment[]): Promise<void> {
	chatError = null;
	retryStatus = null;

	// Offline check
	if (typeof navigator !== 'undefined' && !navigator.onLine) {
		chatError = t('chat.error_offline');
		return;
	}

	let retried = false;
	let sid = await ensureSession();

	// Find and un-queue if this message was already added as queued
	let userMsgIdx: number;
	const queuedIdx = messages.findIndex((m) => m.role === 'user' && m.queued && m.content.startsWith(task.slice(0, 50)));
	if (queuedIdx !== -1) {
		messages[queuedIdx]!.queued = false;
		messages[queuedIdx]!.failed = false;
		userMsgIdx = queuedIdx;
	} else {
		const fileNames = files?.map((f) => f.name).join(', ');
		messages.push({ role: 'user', content: fileNames ? `${task}\n📎 ${fileNames}` : task });
		userMsgIdx = messages.length - 1;
	}

	const assistantIdx = messages.length;
	messages.push({ role: 'assistant', content: '', toolCalls: [] });

	isStreaming = true;

	const payload: Record<string, unknown> = { task };
	if (files && files.length > 0) {
		payload['files'] = files;
	}

	let res = await fetch(`${getApiBase()}/sessions/${sid}/run`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});

	// Session expired (e.g. after container restart) — recreate and retry
	if (res.status === 404) {
		sessionId = null;
		sid = await ensureSession();
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

	if (!res.ok || !res.body) {
		isStreaming = false;
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
		chatError = t('chat.error_connection');
		chatErrorDetail = null;
		if (messages[assistantIdx] && !messages[assistantIdx]!.content) messages.splice(assistantIdx, 1);
		if (messages[userMsgIdx]) messages[userMsgIdx]!.failed = true;
	} finally {
		try { reader.cancel(); } catch { /* already closed */ }
	}

	isStreaming = false;
	pendingPermission = null;
	retryStatus = null;
	persistChat();

	// Refresh thread list so sidebar reflects updated ordering
	void loadThreads();

	// Process queue: send next queued message
	if (messageQueue.length > 0) {
		const next = messageQueue.shift()!;
		// Small delay so the UI updates before next run starts
		setTimeout(() => { _executeRun(next.task, next.files); }, 100);
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
				// Interleaved blocks: add tool_call block in order
				msg.blocks = msg.blocks ?? [];
				msg.blocks.push({ type: 'tool_call', index: tcIndex });
			}
			msg._toolSinceText = true;
			setContext({ type: 'tool', toolName, toolInput, title: toolName });
			break;
		}
		case 'tool_result': {
			const toolName = String(data['name'] ?? '');
			const tc = msg.toolCalls?.find((t) => t.name === toolName && t.status === 'running')
				?? msg.toolCalls?.findLast((t) => t.name === toolName);
			if (tc) {
				tc.result = String(data['result'] ?? '');
				tc.status = 'done';
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
		case 'prompt':
			pendingPermission = {
				question: String(data['question'] ?? ''),
				options: data['options'] as string[] | undefined,
				timeoutMs: data['timeoutMs'] as number | undefined,
				receivedAt: Date.now(),
				promptId: data['promptId'] as string | undefined,
			};
			break;
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
			const usage = data['usage'] as Record<string, number> | undefined;
			if (usage) {
				const baseTok = usage['input_tokens'] ?? 0;
				const cacheRead = usage['cache_read_input_tokens'] ?? 0;
				const cacheWrite = usage['cache_creation_input_tokens'] ?? 0;
				const inTok = baseTok + cacheWrite + cacheRead;
				const outTok = usage['output_tokens'] ?? 0;
				const costUsd = estimateCost(sessionModel, {
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
	await fetch(`${getApiBase()}/sessions/${sessionId}/reply`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ answer, promptId })
	});
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
		if (promptType === 'ask_user') {
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
	await fetch(`${getApiBase()}/sessions/${sessionId}/abort`, { method: 'POST' });
	isStreaming = false;
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

export function getMessages() {
	return messages;
}
export function getIsStreaming() {
	return isStreaming;
}
export function getQueueLength() {
	return messageQueue.length;
}
export function getPendingPermission() {
	return pendingPermission;
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
	pendingPermission = null;
	pendingSecretPrompt = null;
	pendingChangeset = null;
	changesetLoading = false;
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

	// Clear state immediately so UI doesn't show stale data
	messages = [];
	sessionId = threadId;
	chatError = null;
	isStreaming = false;
	pendingPermission = null;
	pendingChangeset = null;
	changesetLoading = false;
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

		// Load messages for display
		const msgRes = await fetch(`${getApiBase()}/threads/${threadId}/messages`, {
			signal: controller.signal,
		});
		if (gen !== _resumeGeneration) return; // superseded by newer click
		if (msgRes.ok) {
			const msgData = (await msgRes.json()) as { messages: Array<{ role: string; content: unknown }> };
			messages = msgData.messages.map((m) => ({
				role: m.role as 'user' | 'assistant',
				content: typeof m.content === 'string' ? m.content : extractContentText(m.content),
				toolCalls: extractToolCalls(m.content),
			}));
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

function extractContentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return (content as Array<Record<string, unknown>>)
		.filter((b) => b['type'] === 'text')
		.map((b) => String(b['text'] ?? ''))
		.join('');
}

function extractToolCalls(content: unknown): ToolCallInfo[] {
	if (!Array.isArray(content)) return [];
	return (content as Array<Record<string, unknown>>)
		.filter((b) => b['type'] === 'tool_use')
		.map((b) => ({
			name: String(b['name'] ?? ''),
			input: b['input'],
			status: 'done' as const,
		}));
}
