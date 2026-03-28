import { getApiBase } from '../config.svelte.js';
import { setContext, clearContext } from './context-panel.svelte.js';

export interface ChatMessage {
	role: 'user' | 'assistant';
	content: string;
	toolCalls?: ToolCallInfo[];
	thinking?: string;
	costUsd?: number;
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

let messages = $state<ChatMessage[]>([]);
let sessionId = $state<string | null>(null);
let currentRunId = $state<string | null>(null);
let isStreaming = $state(false);
let pendingPermission = $state<PermissionPrompt | null>(null);
let chatError = $state<string | null>(null);

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
	chatError = null;
	const sid = await ensureSession();

	const fileNames = files?.map((f) => f.name).join(', ');
	messages.push({ role: 'user', content: fileNames ? `${task}\n📎 ${fileNames}` : task });
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
		chatError = 'Failed to start run';
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
		chatError = 'Connection lost';
	}

	isStreaming = false;
	pendingPermission = null;
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
		case 'turn_end':
			break;
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

export function getMessages() {
	return messages;
}
export function getIsStreaming() {
	return isStreaming;
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
	clearContext();
}
