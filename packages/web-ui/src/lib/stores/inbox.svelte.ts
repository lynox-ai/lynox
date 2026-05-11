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

// Cold-start wire shapes mirror `core/src/integrations/inbox/cold-start{,-tracker}.ts`.
// Update in lockstep when the API envelope changes.
export interface ColdStartProgress {
	accountId: string;
	uniqueThreads: number;
	enqueued: number;
	capped: boolean;
	capValue: number;
}

export interface ColdStartReport {
	accountId: string;
	uniqueThreads: number;
	enqueued: number;
	cappedAt: number | null;
	rejectedByQueue: number;
	estimatedCostUSD: number;
}

export interface ColdStartActiveEntry {
	accountId: string;
	status: 'running';
	startedAt: string;
	progress: ColdStartProgress | null;
}

export interface ColdStartRecentEntry {
	accountId: string;
	status: 'completed' | 'failed';
	startedAt: string;
	finishedAt: string;
	report: ColdStartReport | null;
	error: string | null;
}

export interface ColdStartSnapshot {
	active: ColdStartActiveEntry[];
	recent: ColdStartRecentEntry[];
}

const ZERO_COUNTS: InboxCounts = { requires_user: 0, draft_ready: 0, auto_handled: 0 };
const EMPTY_COLD_START: ColdStartSnapshot = { active: [], recent: [] };

let counts = $state<InboxCounts>(ZERO_COUNTS);
let itemsByBucket = $state<Record<InboxBucket, InboxItem[]>>({
	requires_user: [],
	draft_ready: [],
	auto_handled: [],
});
let loadingBucket = $state<InboxBucket | null>(null);
/** Top-level availability flag — flips to false once `/api/inbox/counts` returns 503. */
let available = $state(true);
let coldStart = $state<ColdStartSnapshot>(EMPTY_COLD_START);
let dismissedColdStart = $state<Record<string, true>>({});

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

export function getColdStartSnapshot(): ColdStartSnapshot {
	return coldStart;
}

/**
 * Visible active runs after honoring user-dismissals. A dismissal is keyed
 * by accountId so a new run on the same account re-shows the banner.
 */
export function getVisibleColdStartActive(): ColdStartActiveEntry[] {
	return coldStart.active.filter((a) => dismissedColdStart[a.accountId] !== true);
}

/**
 * Recently-completed runs that the user has not dismissed. Used to flash
 * a "Imported N threads ≈ $X" confirmation post-completion.
 */
export function getVisibleColdStartRecent(): ColdStartRecentEntry[] {
	return coldStart.recent.filter((r) => dismissedColdStart[r.accountId] !== true);
}

export function dismissColdStartForAccount(accountId: string): void {
	dismissedColdStart = { ...dismissedColdStart, [accountId]: true };
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
		const params = new URLSearchParams({
			bucket,
			limit: String(limit),
			offset: String(offset),
		});
		const res = await fetch(`${getApiBase()}/inbox/items?${params.toString()}`);
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
	const found = findItemAcrossBuckets(id);
	const snapshot = found
		? { userAction: found.item.userAction, userActionAt: found.item.userActionAt }
		: null;
	if (found) {
		found.item.userAction = action ?? undefined;
		found.item.userActionAt = action ? (at ?? new Date()).toISOString() : undefined;
	}
	const res = await fetch(`${getApiBase()}/inbox/items/${id}/action`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ action, at: at?.toISOString() }),
	});
	if (!res.ok) {
		addToast(t('inbox.error_action'), 'error');
		if (found && snapshot) {
			found.item.userAction = snapshot.userAction;
			found.item.userActionAt = snapshot.userActionAt;
		}
		return;
	}
	// UNDO (action=null) needs a reload to find which bucket the item moved back to.
	if (action === null) {
		await Promise.all([loadInboxCounts(), loadInboxItems('requires_user')]);
	} else if (found) {
		itemsByBucket['requires_user'] = itemsByBucket['requires_user'].filter((i) => i.id !== id);
		await loadInboxCounts();
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

function findItemAcrossBuckets(
	id: string,
): { item: InboxItem; bucket: InboxBucket } | undefined {
	for (const bucket of ['requires_user', 'draft_ready', 'auto_handled'] as const) {
		const item = itemsByBucket[bucket].find((i) => i.id === id);
		if (item) return { item, bucket };
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

/** Fetch a single cold-start snapshot. Returns true on a successful fetch. */
export async function loadColdStart(): Promise<boolean> {
	try {
		const res = await fetch(`${getApiBase()}/inbox/cold-start`);
		if (!res.ok) return false;
		const data = (await res.json()) as ColdStartSnapshot;
		coldStart = {
			active: Array.isArray(data.active) ? data.active : [],
			recent: Array.isArray(data.recent) ? data.recent : [],
		};
		return true;
	} catch {
		return false;
	}
}

/**
 * Poll the cold-start endpoint while a banner could be visible. Cadence:
 *   - 2 s while an active run is known
 *   - 15 s while idle (catches a newly-triggered run within ~15 s)
 *   - 60 s while the tab is hidden (battery + server)
 *   - exponential backoff capped at 60 s after consecutive fetch failures
 */
export function startColdStartPolling(): () => void {
	if (typeof window === 'undefined') return () => {};
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let consecutiveFailures = 0;

	const nextDelayMs = (): number => {
		if (consecutiveFailures > 0) {
			return Math.min(60_000, 5000 * 2 ** (consecutiveFailures - 1));
		}
		if (typeof document !== 'undefined' && document.hidden) return 60_000;
		return coldStart.active.length > 0 ? 2000 : 15_000;
	};

	const tick = async (): Promise<void> => {
		if (cancelled) return;
		const ok = await loadColdStart();
		if (cancelled) return;
		consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
		timer = setTimeout(() => void tick(), nextDelayMs());
	};
	void tick();

	return () => {
		cancelled = true;
		if (timer !== null) clearTimeout(timer);
	};
}
