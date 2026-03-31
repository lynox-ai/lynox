import { getApiBase } from '../config.svelte.js';

export interface Thread {
	id: string;
	title: string;
	model_tier: string;
	message_count: number;
	total_cost_usd: number;
	is_archived: number;
	is_favorite: number;
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

export async function toggleFavorite(id: string): Promise<void> {
	const thread = threads.find((t) => t.id === id);
	if (!thread) return;
	const newValue = thread.is_favorite ? false : true;
	await fetch(`${getApiBase()}/threads/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ is_favorite: newValue }),
	});
	thread.is_favorite = newValue ? 1 : 0;
}

export function getThreads() {
	return threads.toSorted((a, b) => {
		if (a.is_favorite !== b.is_favorite) return b.is_favorite - a.is_favorite;
		return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
	});
}
export function getIsLoadingThreads() {
	return isLoading;
}
