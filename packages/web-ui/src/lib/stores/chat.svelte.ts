import { getApiBase } from '../config.svelte.js';
import { t } from '../i18n.svelte.js';
import { setContext, clearContext } from './context-panel.svelte.js';

export interface UsageInfo {
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	toolCalls?: ToolCallInfo[];
	thinking?: string;
	usage?: UsageInfo;
	queued?: boolean;
}

export interface ToolCallInfo {
	name: string;
	input: unknown;
	result?: string;
	status: 'running' | 'done' | 'error';
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

function persistChat(): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem('lynox-chat', JSON.stringify({ messages, sessionId }));
	} catch { /* quota exceeded */ }
}

const persisted = loadPersistedChat();
let messages = $state<ChatMessage[]>(persisted.messages);
let sessionId = $state<string | null>(persisted.sessionId);
let currentRunId = $state<string | null>(null);
let isStreaming = $state(false);
let pendingPermission = $state<PermissionPrompt | null>(null);
let chatError = $state<string | null>(null);
let messageQueue = $state<QueuedMessage[]>([]);

async function ensureSession(): Promise<string> {
	if (sessionId) return sessionId;
	const res = await fetch(`${getApiBase()}/sessions`, { method: 'POST' });
	const data = (await res.json()) as { sessionId: string };
	sessionId = data.sessionId;
	return sessionId;
}

export interface FileAttachment {
	name: string;
	type: string;
	data: string; // base64
}

export async function sendMessage(task: string, files?: FileAttachment[]): Promise<void> {
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
					const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
					handleSSEEvent(eventType, data, assistantIdx);
					eventType = '';
				}
			}
		}
	} catch {
		chatError = t('chat.error_connection');
	}

	isStreaming = false;
	pendingPermission = null;
	persistChat();

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
		case 'text':
			msg.content += String(data['text'] ?? '');
			break;
		case 'thinking':
			msg.thinking = (msg.thinking ?? '') + String(data['thinking'] ?? '');
			break;
		case 'tool_call': {
			const toolName = String(data['name'] ?? '');
			const toolInput = data['input'];
			msg.toolCalls = msg.toolCalls ?? [];
			msg.toolCalls.push({ name: toolName, input: toolInput, status: 'running' });
			setContext({ type: 'tool', toolName, toolInput, title: toolName });
			break;
		}
		case 'tool_result': {
			const tc = msg.toolCalls?.findLast((t) => t.name === String(data['name'] ?? ''));
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
			}
			break;
		}
		case 'done':
			break;
		case 'error':
			chatError = String(data['error'] ?? 'Unknown error');
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
export function clearError() {
	chatError = null;
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
	if (sessionId) {
		fetch(`${getApiBase()}/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
	}
	messages = [];
	sessionId = null;
	currentRunId = null;
	isStreaming = false;
	pendingPermission = null;
	chatError = null;
	messageQueue = [];
	clearContext();
	persistChat();
}
