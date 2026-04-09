import { getApiBase } from '../config.svelte.js';
import { addToast } from './toast.svelte.js';
import { t } from '../i18n.svelte.js';

export interface Thread {
	id: string;
	title: string;
	model_tier: string;
	message_count: number;
	total_cost_usd: number;
	is_archived: number;
	is_favorite: number;
	skip_extraction: number;
	created_at: string;
	updated_at: string;
}

let threads = $state<Thread[]>([]);
let isLoading = $state(false);

/** Callback invoked when the active thread is removed (archived/deleted). Consumer should navigate away. */
let _onActiveThreadRemoved: ((id: string) => void) | null = null;

export function onActiveThreadRemoved(cb: (id: string) => void): void {
	_onActiveThreadRemoved = cb;
}

export async function loadThreads(): Promise<void> {
	isLoading = true;
	try {
		const res = await fetch(`${getApiBase()}/threads?limit=50`);
		if (res.ok) {
			const data = (await res.json()) as { threads: Thread[] };
			threads = data.threads.filter((t) => t.message_count > 0);
		}
	} catch {
		// Silently fail — thread list is non-critical
	} finally {
		isLoading = false;
	}
}

export async function archiveThread(id: string, activeSessionId?: string | null): Promise<void> {
	const res = await fetch(`${getApiBase()}/threads/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ is_archived: true }),
	});
	if (!res.ok) {
		addToast(t('threads.error_archive'), 'error');
		return;
	}
	threads = threads.filter((t) => t.id !== id);
	if (activeSessionId && activeSessionId === id) _onActiveThreadRemoved?.(id);
}

export async function unarchiveThread(id: string): Promise<void> {
	const res = await fetch(`${getApiBase()}/threads/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ is_archived: false }),
	});
	if (!res.ok) {
		addToast(t('threads.error_unarchive'), 'error');
		return;
	}
	await loadThreads();
}

export async function deleteThread(id: string, activeSessionId?: string | null): Promise<void> {
	const res = await fetch(`${getApiBase()}/threads/${id}`, { method: 'DELETE' });
	if (!res.ok) {
		addToast(t('threads.error_delete'), 'error');
		return;
	}
	threads = threads.filter((t) => t.id !== id);
	if (activeSessionId && activeSessionId === id) _onActiveThreadRemoved?.(id);
}

export async function renameThread(id: string, title: string): Promise<void> {
	const prev = threads.find((t) => t.id === id)?.title;
	const thread = threads.find((t) => t.id === id);
	if (thread) thread.title = title;
	const res = await fetch(`${getApiBase()}/threads/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ title }),
	});
	if (!res.ok) {
		if (thread && prev != null) thread.title = prev;
		addToast(t('threads.error_rename'), 'error');
	}
}

export async function toggleFavorite(id: string): Promise<void> {
	const thread = threads.find((t) => t.id === id);
	if (!thread) return;
	const newValue = thread.is_favorite ? false : true;
	// Optimistic update
	thread.is_favorite = newValue ? 1 : 0;
	const res = await fetch(`${getApiBase()}/threads/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ is_favorite: newValue }),
	});
	if (!res.ok) {
		// Rollback
		thread.is_favorite = newValue ? 0 : 1;
		addToast(t('threads.error_favorite'), 'error');
	}
}

export async function toggleExtraction(id: string): Promise<void> {
	const thread = threads.find((t) => t.id === id);
	if (!thread) return;
	const oldValue = thread.skip_extraction;
	const newValue = oldValue ? false : true;
	// Optimistic update
	thread.skip_extraction = newValue ? 1 : 0;
	const res = await fetch(`${getApiBase()}/threads/${id}`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ skip_extraction: newValue }),
	});
	if (!res.ok) {
		// Rollback to previous state
		thread.skip_extraction = oldValue;
		addToast(t('threads.error_extraction'), 'error');
	}
}

/** Auto-refresh thread list when tab regains focus (e.g. after using mobile). */
export function startVisibilityRefresh(): () => void {
	if (typeof document === 'undefined') return () => {};
	const handler = () => {
		if (document.visibilityState === 'visible') void loadThreads();
	};
	document.addEventListener('visibilitychange', handler);
	return () => document.removeEventListener('visibilitychange', handler);
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
