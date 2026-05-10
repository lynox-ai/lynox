// === Inbox store ===
//
// Talks to the engine's `/api/inbox/*` surface (shipped in #266). The
// types are the on-the-wire JSON shape — keep them in sync with
// `core/src/integrations/inbox/state.ts` `InboxItem` + audit / counts.
//
// Phase 1b ships the Needs-You zone only; the other two zones reuse the
// same fetcher with a different bucket filter once their views land.

import { getApiBase } from '../config.svelte.js';
import { t } from '../i18n.svelte.js';
import { addToast } from './toast.svelte.js';

export type InboxBucket = 'requires_user' | 'draft_ready' | 'auto_handled';
export type InboxChannel = 'email' | 'whatsapp';
export type InboxUserAction = 'archived' | 'replied' | 'snoozed' | 'unhandled';

export interface InboxItem {
	id: string;
	tenantId: string;
	accountId: string;
	channel: InboxChannel;
	threadKey: string;
	bucket: InboxBucket;
	confidence: number;
	reasonDe: string;
	classifiedAt: string; // ISO
	classifierVersion: string;
	userAction?: InboxUserAction | undefined;
	userActionAt?: string | undefined;
	draftId?: string | undefined;
	snoozeUntil?: string | undefined;
	snoozeCondition?: string | undefined;
	unsnoozeOnReply: boolean;
}

export interface InboxCounts {
	requires_user: number;
	draft_ready: number;
	auto_handled: number;
}

export interface InboxAuditEntry {
	id: string;
	tenantId: string;
	itemId: string;
	action: string;
	actor: string;
	payloadJson: string;
	createdAt: string;
}

const ZERO_COUNTS: InboxCounts = { requires_user: 0, draft_ready: 0, auto_handled: 0 };

let counts = $state<InboxCounts>(ZERO_COUNTS);
let itemsByBucket = $state<Record<InboxBucket, InboxItem[]>>({
	requires_user: [],
	draft_ready: [],
	auto_handled: [],
});
let loadingBucket = $state<InboxBucket | null>(null);
/** Top-level availability flag — flips to false once `/api/inbox/counts` returns 503. */
let available = $state(true);

export function getInboxCounts(): InboxCounts {
	return counts;
}

export function getInboxItems(bucket: InboxBucket): InboxItem[] {
	return itemsByBucket[bucket];
}

export function isLoading(bucket: InboxBucket): boolean {
	return loadingBucket === bucket;
}

export function isInboxAvailable(): boolean {
	return available;
}

/** Load per-bucket counts. Returns false when the runtime is not wired (flag off). */
export async function loadInboxCounts(): Promise<boolean> {
	try {
		const res = await fetch(`${getApiBase()}/inbox/counts`);
		if (res.status === 503) {
			available = false;
			return false;
		}
		if (!res.ok) return false;
		const data = (await res.json()) as { counts: InboxCounts };
		counts = { ...ZERO_COUNTS, ...data.counts };
		available = true;
		return true;
	} catch {
		return false;
	}
}

export async function loadInboxItems(bucket: InboxBucket, limit = 50, offset = 0): Promise<void> {
	loadingBucket = bucket;
	try {
		const url = `${getApiBase()}/inbox/items?bucket=${bucket}&limit=${String(limit)}&offset=${String(offset)}`;
		const res = await fetch(url);
		if (res.status === 503) {
			available = false;
			itemsByBucket[bucket] = [];
			return;
		}
		if (!res.ok) {
			addToast(t('inbox.error_load'), 'error');
			return;
		}
		const data = (await res.json()) as { items: InboxItem[] };
		itemsByBucket[bucket] = data.items;
	} catch {
		addToast(t('inbox.error_load'), 'error');
	} finally {
		loadingBucket = null;
	}
}

/**
 * Apply a user action (archive / reply / snooze / clear-to-unhandled).
 * Pass `null` to undo a prior action. Optimistic — rolls back on error.
 */
export async function setItemAction(
	id: string,
	action: InboxUserAction | null,
	at?: Date | undefined,
): Promise<void> {
	const prev = findItemAcrossBuckets(id);
	if (prev) {
		prev.userAction = action ?? undefined;
		prev.userActionAt = action ? (at ?? new Date()).toISOString() : undefined;
	}
	const res = await fetch(`${getApiBase()}/inbox/items/${id}/action`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, at: at?.toISOString() }),
	});
	if (!res.ok) {
		addToast(t('inbox.error_action'), 'error');
		// Force a reload to recover canonical state.
		await loadInboxItems('requires_user');
	} else {
		// On success, remove the item from the bucket it was visible in
		// (archive/reply/snooze remove from Needs-You). UNDO (action=null)
		// requires reload to know where the item lives now.
		if (action === null) {
			await Promise.all([loadInboxCounts(), loadInboxItems('requires_user')]);
		} else if (prev) {
			itemsByBucket['requires_user'] = itemsByBucket['requires_user'].filter((i) => i.id !== id);
			await loadInboxCounts();
		}
	}
}

export async function setItemSnooze(
	id: string,
	until: Date | null,
	condition?: string | null,
	unsnoozeOnReply = true,
): Promise<void> {
	const res = await fetch(`${getApiBase()}/inbox/items/${id}/snooze`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			until: until?.toISOString() ?? null,
			condition: condition ?? null,
			unsnoozeOnReply,
		}),
	});
	if (!res.ok) {
		addToast(t('inbox.error_snooze'), 'error');
		return;
	}
	// Snoozed items leave the Needs-You list. Reload counts.
	itemsByBucket['requires_user'] = itemsByBucket['requires_user'].filter((i) => i.id !== id);
	await loadInboxCounts();
}

export async function loadItemAudit(id: string): Promise<InboxAuditEntry[]> {
	try {
		const res = await fetch(`${getApiBase()}/inbox/items/${id}/audit`);
		if (!res.ok) return [];
		const data = (await res.json()) as { entries: InboxAuditEntry[] };
		return data.entries;
	} catch {
		return [];
	}
}

function findItemAcrossBuckets(id: string): InboxItem | undefined {
	for (const bucket of ['requires_user', 'draft_ready', 'auto_handled'] as const) {
		const item = itemsByBucket[bucket].find((i) => i.id === id);
		if (item) return item;
	}
	return undefined;
}

/** Auto-refresh counts when the tab regains focus. */
export function startInboxVisibilityRefresh(): () => void {
	if (typeof document === 'undefined') return () => {};
	const handler = (): void => {
		if (document.visibilityState === 'visible') void loadInboxCounts();
	};
	document.addEventListener('visibilitychange', handler);
	return () => document.removeEventListener('visibilitychange', handler);
}
