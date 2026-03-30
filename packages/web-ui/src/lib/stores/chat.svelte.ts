import { getApiBase } from '../config.svelte.js';
import { t } from '../i18n.svelte.js';
import { setContext, clearContext } from './context-panel.svelte.js';
import { loadThreads } from './threads.svelte.js';

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
let currentRunId = $state<string | null>(null);
let isStreaming = $state(false);
let pendingPermission = $state<PermissionPrompt | null>(null);
let chatError = $state<string | null>(null);
let messageQueue = $state<QueuedMessage[]>([]);
let sessionModel = $state<string | null>(null);
let contextWindow = $state<number>(200_000);
let contextBudget = $state<ContextBudget | null>(null);
let pendingChangeset = $state<ChangesetFileInfo[] | null>(null);
let changesetLoading = $state(false);

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
		chatError = t('changeset.review_pending');
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

async function _executeRun(task: string, files?: FileAttachment[]): Promise<void> {
	chatError = null;
	const sid = await ensureSession();

	// Find and un-queue if this message was already added as queued
	const queuedIdx = messages.findIndex((m) => m.role === 'user' && m.queued && m.content.startsWith(task.slice(0, 50)));
	if (queuedIdx !== -1) {
		messages[queuedIdx]!.queued = false;
	} else {
		const fileNames = files?.map((f) => f.name).join(', ');
		messages.push({ role: 'user', content: fileNames ? `${task}\n📎 ${fileNames}` : task });
	}

	const assistantIdx = messages.length;
	messages.push({ role: 'assistant', content: '', toolCalls: [] });

	isStreaming = true;

	const payload: Record<string, unknown> = { task };
	if (files && files.length > 0) {
		payload['files'] = files;
	}

	const res = await fetch(`${getApiBase()}/sessions/${sid}/run`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});

	if (!res.ok || !res.body) {
		isStreaming = false;
		chatError = res.status === 409 ? t('chat.error_busy') : t('chat.error_start');
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
						handleSSEEvent(eventType, data, assistantIdx);
					} catch { /* skip malformed SSE events */ }
					eventType = '';
				}
			}
		}
	} catch {
		chatError = t('chat.error_connection');
	} finally {
		try { reader.cancel(); } catch { /* already closed */ }
	}

	isStreaming = false;
	pendingPermission = null;
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

function handleSSEEvent(type: string, data: Record<string, unknown>, idx: number): void {
	const msg = messages[idx];
	if (!msg) return;

	switch (type) {
		case 'text': {
			const text = String(data['text'] ?? '');
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
				options: data['options'] as string[] | undefined
			};
			break;
		case 'turn_end': {
			const usage = data['usage'] as Record<string, number> | undefined;
			if (usage) {
				const inTok = (usage['input_tokens'] ?? 0)
					+ (usage['cache_creation_input_tokens'] ?? 0)
					+ (usage['cache_read_input_tokens'] ?? 0);
				const outTok = usage['output_tokens'] ?? 0;
				const cacheRead = usage['cache_read_input_tokens'] ?? 0;
				const cacheWrite = usage['cache_creation_input_tokens'] ?? 0;
				// Rough cost estimate (Sonnet pricing as default)
				const costUsd = (inTok * 3 + outTok * 15 + cacheWrite * 3.75 + cacheRead * 0.3) / 1_000_000;
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
		case 'error':
			chatError = String(data['error'] ?? 'Unknown error');
			break;
		case 'changeset_ready':
			void fetchChangeset();
			break;
	}
}

export async function replyPermission(answer: string): Promise<void> {
	if (!sessionId) return;
	pendingPermission = null;
	await fetch(`${getApiBase()}/sessions/${sessionId}/reply`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ answer })
	});
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
export function getSessionModel() {
	return sessionModel;
}
export function getContextWindow() {
	return contextWindow;
}
export function getContextBudget() {
	return contextBudget;
}
export function clearError() {
	chatError = null;
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
	currentRunId = null;
	isStreaming = false;
	pendingPermission = null;
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

export async function resumeThread(threadId: string): Promise<void> {
	// Create backend session from persisted thread
	const res = await fetch(`${getApiBase()}/sessions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ threadId }),
	});
	if (!res.ok) return;
	const data = (await res.json()) as { sessionId: string; model?: string; contextWindow?: number };
	sessionId = data.sessionId;
	if (data.model) sessionModel = data.model;
	if (data.contextWindow) contextWindow = data.contextWindow;

	// Load messages for display
	const msgRes = await fetch(`${getApiBase()}/threads/${threadId}/messages`);
	if (msgRes.ok) {
		const msgData = (await msgRes.json()) as { messages: Array<{ role: string; content: unknown }> };
		messages = msgData.messages.map((m) => ({
			role: m.role as 'user' | 'assistant',
			content: typeof m.content === 'string' ? m.content : extractContentText(m.content),
			toolCalls: extractToolCalls(m.content),
		}));
	}

	chatError = null;
	pendingPermission = null;
	pendingChangeset = null;
	changesetLoading = false;
	messageQueue = [];
	contextBudget = null;
	clearContext();
	persistChatNow();
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
