import { getApiBase } from '../config.svelte.js';

export interface Thread {
	id: string;
	title: string;
	model_tier: string;
	message_count: number;
	total_cost_usd: number;
	is_archived: number;
	created_at: string;
	updated_at: string;
}

let threads = $state<Thread[]>([]);
let isLoading = $state(false);

export async function loadThreads(): Promise<void> {
	isLoading = true;
	try {
		const res = await fetch(`${getApiBase()}/threads?limit=50`);
		if (res.ok) {
			const data = (await res.json()) as { threads: Thread[] };
			threads = data.threads;
		}
	} catch {
		// Silently fail — thread list is non-critical
	} finally {
		isLoading = false;
	}
}

export async function archiveThread(id: string): Promise<void> {
	await fetch(`${getApiBase()}/threads/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ is_archived: true }),
	});
	threads = threads.filter((t) => t.id !== id);
}

export async function deleteThread(id: string): Promise<void> {
	await fetch(`${getApiBase()}/threads/${id}`, { method: 'DELETE' });
	threads = threads.filter((t) => t.id !== id);
}

export async function renameThread(id: string, title: string): Promise<void> {
	await fetch(`${getApiBase()}/threads/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ title }),
	});
	const thread = threads.find((t) => t.id === id);
	if (thread) thread.title = title;
}

export function getThreads() {
	return threads;
}
export function getIsLoadingThreads() {
	return isLoading;
}
