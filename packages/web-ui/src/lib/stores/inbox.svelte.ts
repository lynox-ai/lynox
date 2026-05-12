// === Inbox store ===
//
// Talks to the engine's `/api/inbox/*` surface (shipped in #266). The
// types are the on-the-wire JSON shape — keep them in sync with
// `core/src/integrations/inbox/state.ts` `InboxItem` + audit / counts.
//
// Phase 1b ships the Needs-You zone only; the other two zones reuse the
// same fetcher with a different bucket filter once their views land.

import {
	createDraft as apiCreateDraft,
	generateDraft as apiGenerateDraft,
	getItemDraft as apiGetItemDraft,
	refreshItemBody as apiRefreshItemBody,
	sendInboxReply as apiSendInboxReply,
	updateDraft as apiUpdateDraft,
	type DraftTone,
	type GenerateDraftFailure,
	type InboxDraft,
	type RefreshBodyFailure,
	type SendReplyFailure,
} from '../api/inbox-drafts.js';

export type { DraftTone, RefreshBodyFailure, SendReplyFailure };
import { getApiBase } from '../config.svelte.js';
import { t } from '../i18n.svelte.js';
import { addToast } from './toast.svelte.js';

export type { InboxDraft };

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
	// v11 envelope metadata — pre-v11 rows expose '' / undefined until the
	// operator-driven backfill endpoint (POST /api/inbox/backfill-metadata)
	// fills them in place.
	fromAddress: string;
	fromName?: string | undefined;
	subject: string;
	mailDate?: string | undefined; // ISO
	snippet?: string | undefined;
	messageId?: string | undefined;
	inReplyTo?: string | undefined;
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

export interface UndoableAction {
	kind: 'archive' | 'snooze';
	itemId: string;
}
let lastAction = $state<UndoableAction | null>(null);

// ── Bulk selection + undo (PRD-INBOX-PHASE-3 §"Bulk Actions") ──────────────

export type BulkAction = 'archived' | 'snoozed' | 'unhandled';

export interface BulkActionResult {
	bulkId: string;
	action: BulkAction;
	itemCount: number;
	performedAt: number; // ms epoch — drives the 60s toast countdown
}

let selectedForBulk = $state(new Set<string>());
let lastSelectedId = $state<string | null>(null);
let recentBulks = $state<BulkActionResult[]>([]);

export function getSelectedForBulk(): ReadonlySet<string> {
	return selectedForBulk;
}

export function isSelectedForBulk(id: string): boolean {
	return selectedForBulk.has(id);
}

export function getSelectionCount(): number {
	return selectedForBulk.size;
}

export function getRecentBulks(): ReadonlyArray<BulkActionResult> {
	return recentBulks;
}

/**
 * Toggle a single item. With `shift=true` and a previously-selected
 * anchor, select the inclusive range from the anchor to this id
 * across the given ordered list (the visible bucket).
 */
export function toggleBulkSelection(
	id: string,
	visibleOrderedIds: ReadonlyArray<string>,
	shift = false,
): void {
	const next = new Set(selectedForBulk);
	if (shift && lastSelectedId !== null) {
		const from = visibleOrderedIds.indexOf(lastSelectedId);
		const to = visibleOrderedIds.indexOf(id);
		if (from >= 0 && to >= 0) {
			const [lo, hi] = from < to ? [from, to] : [to, from];
			for (let i = lo; i <= hi; i += 1) next.add(visibleOrderedIds[i]!);
			selectedForBulk = next;
			return;
		}
	}
	if (next.has(id)) {
		next.delete(id);
	} else {
		next.add(id);
	}
	selectedForBulk = next;
	lastSelectedId = id;
}

export function clearBulkSelection(): void {
	selectedForBulk = new Set();
	lastSelectedId = null;
}

/**
 * Apply a bulk action to all currently-selected items. Optimistic UI
 * update: items are removed from their current bucket before the
 * server confirms — the UNDO path restores them if the user clicks
 * "Undo" within the 60s window.
 */
export async function applyBulkAction(action: BulkAction): Promise<BulkActionResult | null> {
	const ids = Array.from(selectedForBulk);
	if (ids.length === 0) return null;
	const res = await fetch(`${getApiBase()}/inbox/items/bulk-action`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ids, action }),
	});
	if (!res.ok) {
		addToast(t('inbox.error_bulk_action'), 'error');
		return null;
	}
	const data = (await res.json()) as { bulkId: string; applied: string[]; skipped: { id: string; reason: string }[] };
	// Optimistic removal from each bucket.
	for (const bucket of ['requires_user', 'draft_ready', 'auto_handled'] as const) {
		itemsByBucket[bucket] = itemsByBucket[bucket].filter((i) => !data.applied.includes(i.id));
	}
	const result: BulkActionResult = {
		bulkId: data.bulkId,
		action,
		itemCount: data.applied.length,
		performedAt: Date.now(),
	};
	recentBulks = [result, ...recentBulks].slice(0, 5);
	clearBulkSelection();
	void loadInboxCounts();
	return result;
}

/** Reverse the bulk and refresh affected views. */
export async function undoBulk(bulkId: string, currentZone: InboxBucket): Promise<boolean> {
	const res = await fetch(`${getApiBase()}/inbox/undo/${encodeURIComponent(bulkId)}`, {
		method: 'POST',
	});
	if (!res.ok) {
		addToast(t('inbox.error_bulk_undo'), 'error');
		return false;
	}
	recentBulks = recentBulks.filter((b) => b.bulkId !== bulkId);
	void loadInboxCounts();
	void loadInboxItems(currentZone);
	return true;
}

/** Drop the local cache so a refresh kicks fresh from /undo/recent on next read. */
export function pruneRecentBulks(now = Date.now(), windowMs = 60_000): void {
	recentBulks = recentBulks.filter((b) => now - b.performedAt < windowMs);
}

// ── Compose-new (PRD-INBOX-PHASE-3 §"Compose-New") ─────────────────────────

export interface ComposeDraft {
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	body: string;
}

let composeOpen = $state(false);
let composeDraft = $state<ComposeDraft>({ to: '', cc: '', bcc: '', subject: '', body: '' });
let composeSending = $state(false);

export function isComposeOpen(): boolean {
	return composeOpen;
}

export function getComposeDraft(): ComposeDraft {
	return composeDraft;
}

export function isComposeSending(): boolean {
	return composeSending;
}

export function openCompose(): void {
	composeOpen = true;
	composeDraft = { to: '', cc: '', bcc: '', subject: '', body: '' };
}

export function updateComposeDraft(patch: Partial<ComposeDraft>): void {
	composeDraft = { ...composeDraft, ...patch };
}

export function closeCompose(): void {
	composeOpen = false;
	composeDraft = { to: '', cc: '', bcc: '', subject: '', body: '' };
}

/**
 * Send the compose-new draft. Returns true on success. Account id
 * must come from the caller (the UI's account selector).
 */
export async function sendCompose(accountId: string): Promise<boolean> {
	if (composeSending) return false;
	composeSending = true;
	try {
		const res = await fetch(`${getApiBase()}/inbox/compose-send`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				accountId,
				to: composeDraft.to,
				cc: composeDraft.cc,
				bcc: composeDraft.bcc,
				subject: composeDraft.subject,
				body: composeDraft.body,
			}),
		});
		if (!res.ok) {
			addToast(t('inbox.compose_send_failed'), 'error');
			return false;
		}
		addToast(t('inbox.compose_send_ok'), 'success');
		closeCompose();
		return true;
	} catch {
		addToast(t('inbox.compose_send_failed'), 'error');
		return false;
	} finally {
		composeSending = false;
	}
}

// ── Reading-Pane wire shapes ───────────────────────────────────────────────
//
// Backed by GET /api/inbox/items/:id/full and :id/thread. The store keeps
// the open-item state separate from `itemsByBucket` so closing the pane
// (or switching buckets) doesn't churn the list.

export interface InboxFullBody {
	md: string;
	source: 'cache' | 'missing';
	fetchedAt?: string | undefined; // ISO
}

export interface InboxItemFull {
	item: InboxItem;
	body: InboxFullBody;
}

export type InboxMessageDirection = 'inbound' | 'outbound' | 'unknown';

export interface InboxThreadMessage {
	id: string;
	tenantId: string;
	accountId: string;
	threadKey: string;
	messageId: string;
	inReplyTo?: string | undefined;
	fromAddress: string;
	fromName?: string | undefined;
	toJson?: string | undefined;
	ccJson?: string | undefined;
	subject: string;
	bodyMd?: string | undefined;
	mailDate?: string | undefined; // ISO
	snippet?: string | undefined;
	direction: InboxMessageDirection;
	fetchedAt: string; // ISO
	inboxItemId?: string | undefined;
}

export interface InboxThreadResponse {
	messages: InboxThreadMessage[];
	partial: boolean;
}

let selectedItemId = $state<string | null>(null);
let selectedFull = $state<InboxItemFull | null>(null);
let selectedThread = $state<InboxThreadResponse | null>(null);
let loadingSelected = $state(false);

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

export function getLastAction(): UndoableAction | null {
	return lastAction;
}

// ── Reclassification banner ─────────────────────────────────────────────────
//
// PRD-INBOX-PHASE-3 §"Re-Classification mid-read": when the background
// classifier re-buckets items, show a banner with "N items moved, refresh?".
// PR 3b ships the plumbing — `notifyReclassifyBatch` is called from a
// future PR 3c signal source (classifier diff watcher). The banner UI in
// InboxView reads `getReclassifyBanner()` and clears via dismiss/refresh.

export interface ReclassifyBatch {
	/** How many items moved buckets in this batch. */
	count: number;
	/** Stable per-batch id so a second dismissal doesn't suppress a later batch. */
	batchId: string;
}

let reclassifyBanner = $state<ReclassifyBatch | null>(null);
let dismissedReclassifyBatchIds = new Set<string>();

export function getReclassifyBanner(): ReclassifyBatch | null {
	return reclassifyBanner;
}

export function notifyReclassifyBatch(count: number, batchId: string): void {
	if (count <= 0) return;
	if (dismissedReclassifyBatchIds.has(batchId)) return;
	reclassifyBanner = { count, batchId };
}

export function dismissReclassifyBanner(): void {
	if (reclassifyBanner !== null) {
		dismissedReclassifyBatchIds.add(reclassifyBanner.batchId);
	}
	reclassifyBanner = null;
}

// ── Reading-Pane store API ─────────────────────────────────────────────────

export function getSelectedItemId(): string | null {
	return selectedItemId;
}

export function getSelectedFull(): InboxItemFull | null {
	return selectedFull;
}

export function getSelectedThread(): InboxThreadResponse | null {
	return selectedThread;
}

export function isSelectedLoading(): boolean {
	return loadingSelected;
}

/**
 * Open an item in the Reading-Pane. Sets `selectedItemId` immediately so
 * the pane can render a skeleton; fetches `/full` then `/thread` async.
 * Last-write-wins on rapid clicks via the captured `requestId` guard so
 * a slow `/full` for an earlier click can't overwrite the current view.
 */
let _openRequestId = 0;
export async function openItem(id: string): Promise<void> {
	const requestId = ++_openRequestId;
	selectedItemId = id;
	selectedFull = null;
	selectedThread = null;
	loadingSelected = true;
	try {
		const [fullRes, threadRes] = await Promise.all([
			fetch(`${getApiBase()}/inbox/items/${encodeURIComponent(id)}/full`),
			fetch(`${getApiBase()}/inbox/items/${encodeURIComponent(id)}/thread`),
		]);
		// Stale-response guard: a newer openItem() bumped the request id.
		if (requestId !== _openRequestId) return;
		if (fullRes.ok) {
			selectedFull = (await fullRes.json()) as InboxItemFull;
		}
		if (threadRes.ok) {
			selectedThread = (await threadRes.json()) as InboxThreadResponse;
		}
	} catch {
		// Network error — pane will show its empty/error state via getters.
	} finally {
		if (requestId === _openRequestId) loadingSelected = false;
	}
}

export function closeItem(): void {
	selectedItemId = null;
	selectedFull = null;
	selectedThread = null;
	loadingSelected = false;
	_openRequestId += 1; // cancel any in-flight load
}

/**
 * Refresh the body cache for the currently-selected item — pulls the full
 * mail body from the provider and updates `selectedFull.body.md`. Used by
 * the reading pane's ↻ button so the user can see the full email after
 * landing on the cached snippet from classify-time.
 */
export async function refreshSelectedItemBody(): Promise<
	{ ok: true } | { ok: false; reason: RefreshBodyFailure }
> {
	const itemId = selectedItemId;
	if (!itemId) return { ok: false, reason: { kind: 'aborted' } };
	const result = await apiRefreshItemBody(getApiBase(), itemId);
	if (selectedItemId !== itemId) return { ok: false, reason: { kind: 'aborted' } };
	if (!result.ok) return result;
	if (selectedFull && selectedFull.item.id === itemId) {
		selectedFull = {
			...selectedFull,
			body: { md: result.bodyMd, source: 'cache', fetchedAt: new Date().toISOString() },
		};
	}
	return { ok: true };
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

export async function loadInboxItems(
	bucket: InboxBucket,
	limit = 50,
	offset = 0,
	q?: string,
): Promise<void> {
	loadingBucket = bucket;
	try {
		const params = new URLSearchParams({
			bucket,
			limit: String(limit),
			offset: String(offset),
		});
		if (q !== undefined && q.length > 0) params.set('q', q);
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
		// Only clear if we still own the slot — a faster zone switch can
		// have already started a new load and reassigned loadingBucket.
		if (loadingBucket === bucket) loadingBucket = null;
	}
}

/**
 * Apply a user action (archive / reply / snooze / clear-to-unhandled).
 * Pass `null` to undo a prior action. Optimistic — rolls back on error.
 * Returns true when the server accepted the action.
 */
export async function setItemAction(
	id: string,
	action: InboxUserAction | null,
	at?: Date | undefined,
): Promise<boolean> {
	const found = findItemAcrossBuckets(id);
	const snapshot = found
		? { userAction: found.item.userAction, userActionAt: found.item.userActionAt }
		: null;
	if (found) {
		found.item.userAction = action ?? undefined;
		found.item.userActionAt = action ? (at ?? new Date()).toISOString() : undefined;
	}
	const res = await fetch(`${getApiBase()}/inbox/items/${encodeURIComponent(id)}/action`, {
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
		return false;
	}
	// UNDO (action=null) needs a reload to find which bucket the item moved back to.
	if (action === null) {
		lastAction = null;
		await Promise.all([loadInboxCounts(), loadInboxItems('requires_user')]);
	} else if (found) {
		itemsByBucket[found.bucket] = itemsByBucket[found.bucket].filter((i) => i.id !== id);
		if (action === 'archived') lastAction = { kind: 'archive', itemId: id };
		await loadInboxCounts();
	}
	return true;
}

export type SnoozePreset = 'later_today' | 'tomorrow_morning' | 'monday_9am' | 'next_week';

export async function setItemSnooze(
	id: string,
	until: Date | null,
	condition?: string | null,
	unsnoozeOnReply = true,
	preset?: SnoozePreset | null,
): Promise<boolean> {
	const found = findItemAcrossBuckets(id);
	// When a preset is supplied the server resolves it timezone-aware;
	// pass the user's browser timezone so the cap-at-23:00 (later_today)
	// + next-Monday math anchors to the right wall clock.
	const timezone = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
	const body: Record<string, unknown> = {
		until: until?.toISOString() ?? null,
		condition: condition ?? null,
		unsnoozeOnReply,
	};
	if (preset !== undefined && preset !== null) {
		body['preset'] = preset;
		if (timezone !== undefined) body['timezone'] = timezone;
	}
	const res = await fetch(`${getApiBase()}/inbox/items/${encodeURIComponent(id)}/snooze`, {
		method: 'PATCH',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		addToast(t('inbox.error_snooze'), 'error');
		return false;
	}
	if (until !== null) {
		lastAction = { kind: 'snooze', itemId: id };
	} else {
		lastAction = null;
	}
	if (found) {
		itemsByBucket[found.bucket] = itemsByBucket[found.bucket].filter((i) => i.id !== id);
	}
	await loadInboxCounts();
	return true;
}

/**
 * Reverse the most recent undoable action (archive or snooze). No-op when
 * the slot is empty. The slot survives an inverse failure so the user can
 * press Z again once the network recovers — `setItem*` only mutates
 * `lastAction` on its own success path, so a failed inverse leaves the
 * original entry intact.
 */
export async function undoLastAction(): Promise<void> {
	const action = lastAction;
	if (!action) return;
	if (action.kind === 'archive') {
		await setItemAction(action.itemId, null);
	} else {
		await setItemSnooze(action.itemId, null);
	}
}

export async function loadItemAudit(id: string): Promise<InboxAuditEntry[]> {
	try {
		const res = await fetch(`${getApiBase()}/inbox/items/${encodeURIComponent(id)}/audit`);
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

interface MailAccountSummary {
	id: string;
	address?: string | undefined;
}

/**
 * Trigger the cold-start backfill for every connected mail account. Used by
 * the empty-state button when the unified-inbox flag was flipped on AFTER the
 * accounts were already connected — `onAccountAdded` had no inbox runtime to
 * dispatch to at that point so no backfill ever ran.
 *
 * Force-true bypasses the per-account `hasAnyItemForAccount` short-circuit so
 * an operator can re-trigger even if a previous run partially populated the
 * inbox. Progress shows up on the cold-start banner via the existing polling.
 *
 * Returns the number of accounts that were successfully scheduled. Empty
 * arrays / fetch errors return 0 without throwing — the caller (a button
 * click handler) renders an inline toast on 0.
 */
export async function runColdStartBackfillForAllAccounts(): Promise<number> {
	let scheduled = 0;
	try {
		const accountsRes = await fetch(`${getApiBase()}/mail/accounts`);
		if (!accountsRes.ok) {
			addToast(t('inbox.cold_start_trigger_no_accounts'), 'error');
			return 0;
		}
		const body = (await accountsRes.json()) as { accounts?: MailAccountSummary[] };
		const accounts = Array.isArray(body.accounts) ? body.accounts : [];
		if (accounts.length === 0) {
			addToast(t('inbox.cold_start_trigger_no_accounts'), 'info');
			return 0;
		}
		for (const account of accounts) {
			if (typeof account.id !== 'string' || account.id.length === 0) continue;
			const res = await fetch(`${getApiBase()}/inbox/cold-start/run`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ accountId: account.id, force: true }),
			});
			if (res.status === 202) scheduled += 1;
		}
	} catch {
		// fall through; caller renders the toast on scheduled === 0
	}
	if (scheduled > 0) {
		addToast(t('inbox.cold_start_trigger_scheduled'), 'success');
		// Kick the snapshot once so the banner appears without waiting for the
		// next poll tick.
		void loadColdStart();
	} else {
		addToast(t('inbox.cold_start_trigger_failed'), 'error');
	}
	return scheduled;
}

/**
 * Listeners fired when a cold-start run completes — used by InboxView to
 * auto-refresh the queue without the user having to click anything. Keyed
 * by accountId so a second completion on the same account re-fires.
 */
const _coldStartCompletionListeners = new Set<(accountId: string) => void>();
let _seenCompletedAccountKeys = new Set<string>();

export function onColdStartCompletion(fn: (accountId: string) => void): () => void {
	_coldStartCompletionListeners.add(fn);
	return () => _coldStartCompletionListeners.delete(fn);
}

/** Fetch a single cold-start snapshot. Returns true on a successful fetch. */
export async function loadColdStart(): Promise<boolean> {
	try {
		const res = await fetch(`${getApiBase()}/inbox/cold-start`);
		if (!res.ok) return false;
		const data = (await res.json()) as ColdStartSnapshot;
		const next: ColdStartSnapshot = {
			active: Array.isArray(data.active) ? data.active : [],
			recent: Array.isArray(data.recent) ? data.recent : [],
		};
		// PRD-3 §"Auto-Refresh on Cold-Start Complete": fire the listeners
		// when a completed-entry first appears. Key by `${accountId}:${finishedAt}`
		// (when present) so a re-run on the same account re-fires.
		for (const entry of next.recent) {
			const key = `${entry.accountId}:${entry.finishedAt ?? entry.status}`;
			if (!_seenCompletedAccountKeys.has(key) && entry.status === 'completed') {
				_seenCompletedAccountKeys.add(key);
				for (const fn of _coldStartCompletionListeners) {
					try { fn(entry.accountId); } catch { /* listener errors must not break polling */ }
				}
			}
		}
		coldStart = next;
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

// ── Draft pane ───────────────────────────────────────────────────────────
//
// Owns the currently-open Draft-Reply pane. There is at most one open at
// a time — opening on a new item replaces the previous slot. The pane
// closes when `closeDraftPane()` is called or when the underlying item
// changes (e.g. archived from a J/K shortcut while the pane is open).
//
// `openDraftPane(itemId)` is idempotent. It always fetches the active
// draft for the item (returns `null` when none exists yet, which the
// pane renders as the "no draft, click Draft Reply to create one"
// affordance). Phase 2 ships without LLM-driven generation, so the
// create path stubs a starter body until the generator slice lands.

const DRAFT_GENERATOR_VERSION_STUB = 'manual-2026-05';

interface DraftPaneState {
	itemId: string;
	draft: InboxDraft | null;
	/** True while the active-draft fetch is in flight. */
	loading: boolean;
	/** True while a PATCH (save) round-trip is in flight. */
	saving: boolean;
	/** True while the LLM generation round-trip is in flight. */
	generating: boolean;
	/** Last-known persisted body — used so the pane can flag unsaved buffers. */
	persistedBody: string;
}

let draftPane = $state<DraftPaneState | null>(null);

export function getDraftPane(): DraftPaneState | null {
	return draftPane;
}

export function isDraftPaneOpen(): boolean {
	return draftPane !== null;
}

export async function openDraftPane(itemId: string): Promise<void> {
	draftPane = {
		itemId,
		draft: null,
		loading: true,
		saving: false,
		generating: false,
		persistedBody: '',
	};
	const result = await apiGetItemDraft(getApiBase(), itemId);
	// Race-guard: the user may have closed or re-opened on a different
	// item before the fetch resolved; only commit the result when the
	// pane still belongs to this itemId.
	if (draftPane?.itemId !== itemId) return;
	if (result === undefined) {
		addToast(t('inbox.draft_error_load'), 'error');
		draftPane = { ...draftPane, loading: false };
		return;
	}
	draftPane = {
		...draftPane,
		draft: result,
		loading: false,
		persistedBody: result?.bodyMd ?? '',
	};
}

export function closeDraftPane(): void {
	draftPane = null;
}

/**
 * Create a fresh draft for the open pane's item. Used as the manual
 * fallback when the LLM generator is unavailable (no LLM credentials,
 * channel unsupported, cached body missing). The starter body is
 * intentionally minimal so the user has something editable; the
 * generator slice replaces this whenever it succeeds.
 */
export async function createDraftForOpenPane(starterBody = ''): Promise<void> {
	const pane = draftPane;
	if (!pane) return;
	const initialBody = starterBody.length > 0 ? starterBody : t('inbox.draft_starter_body');
	const created = await apiCreateDraft(getApiBase(), pane.itemId, {
		bodyMd: initialBody,
		generatorVersion: DRAFT_GENERATOR_VERSION_STUB,
	});
	if (draftPane?.itemId !== pane.itemId) return;
	if (!created) {
		addToast(t('inbox.draft_error_create'), 'error');
		return;
	}
	draftPane = {
		...pane,
		draft: created,
		persistedBody: created.bodyMd,
	};
}

/**
 * Ask the backend to LLM-generate a draft for the open pane's item,
 * then commit the generated body via the existing create path. On a
 * recoverable backend failure (`unavailable` / `unsupported` /
 * `no_body`), the caller can fall back to `createDraftForOpenPane`
 * with the manual starter — the discriminated `reason.kind` surfaces
 * which fallback affordance to show.
 *
 * Returns the failure reason on the unhappy path so the UI can show
 * the right copy (e.g. "Generation deaktiviert — Editor öffnen?" for
 * unavailable vs "Mail nicht mehr verfügbar" for not_found).
 */
export async function generateDraftForOpenPane(): Promise<
	{ ok: true } | { ok: false; reason: GenerateDraftFailure }
> {
	const pane = draftPane;
	if (!pane) return { ok: false, reason: { kind: 'aborted' } };
	const itemId = pane.itemId;
	// `generating` stays true across BOTH the LLM call and the follow-up
	// create — clearing it between would flash the empty-draft placeholder
	// for the ~50ms create round-trip.
	draftPane = { ...pane, generating: true };
	const result = await apiGenerateDraft(getApiBase(), itemId);
	if (draftPane?.itemId !== itemId) return { ok: false, reason: { kind: 'aborted' } };
	if (!result.ok) {
		draftPane = { ...draftPane, generating: false };
		return { ok: false, reason: result.reason };
	}
	// Persist the generated body via the existing create path so the
	// supersede chain stays under one writer.
	const created = await apiCreateDraft(getApiBase(), itemId, {
		bodyMd: result.draft.bodyMd,
		generatorVersion: result.draft.generatorVersion,
	});
	if (draftPane?.itemId !== itemId) return { ok: false, reason: { kind: 'aborted' } };
	if (!created) {
		draftPane = { ...draftPane, generating: false };
		addToast(t('inbox.draft_error_create'), 'error');
		return { ok: false, reason: { kind: 'network' } };
	}
	draftPane = {
		...draftPane,
		draft: created,
		generating: false,
		persistedBody: created.bodyMd,
	};
	return { ok: true };
}

/**
 * Regenerate the open pane's draft with a tone modifier. Sends the
 * caller's `currentBuffer` as the previous draft body (so unsaved live
 * edits feed into the rewrite). On success the new draft is persisted
 * via the existing create path with `supersededDraftId` set to the
 * outgoing draft — the supersede chain stays under one writer and the
 * UI gets a fresh `userEditsCount: 0` row to mirror.
 */
export async function regenerateDraftWithTone(
	tone: DraftTone,
	currentBuffer: string,
): Promise<{ ok: true } | { ok: false; reason: GenerateDraftFailure }> {
	const pane = draftPane;
	if (!pane || !pane.draft) return { ok: false, reason: { kind: 'aborted' } };
	const itemId = pane.itemId;
	const supersededId = pane.draft.id;
	draftPane = { ...pane, generating: true };
	const result = await apiGenerateDraft(getApiBase(), itemId, {
		tone,
		previousBodyMd: currentBuffer,
	});
	if (draftPane?.itemId !== itemId) return { ok: false, reason: { kind: 'aborted' } };
	if (!result.ok) {
		draftPane = { ...draftPane, generating: false };
		return { ok: false, reason: result.reason };
	}
	const created = await apiCreateDraft(getApiBase(), itemId, {
		bodyMd: result.draft.bodyMd,
		generatorVersion: result.draft.generatorVersion,
		supersededDraftId: supersededId,
	});
	if (draftPane?.itemId !== itemId) return { ok: false, reason: { kind: 'aborted' } };
	if (!created) {
		draftPane = { ...draftPane, generating: false };
		addToast(t('inbox.draft_error_create'), 'error');
		return { ok: false, reason: { kind: 'network' } };
	}
	draftPane = {
		...draftPane,
		draft: created,
		generating: false,
		persistedBody: created.bodyMd,
	};
	return { ok: true };
}

/**
 * Pull the full mail body from the provider for the open pane's item
 * and overwrite the cached snippet. Subsequent regenerate calls will
 * then see the full body as context. Does NOT alter the open draft —
 * the user explicitly opts in by clicking "Reload from server"; their
 * editor buffer stays untouched.
 */
export async function refreshOpenPaneBody(): Promise<
	{ ok: true } | { ok: false; reason: RefreshBodyFailure }
> {
	const pane = draftPane;
	if (!pane) return { ok: false, reason: { kind: 'aborted' } };
	const itemId = pane.itemId;
	const result = await apiRefreshItemBody(getApiBase(), itemId);
	if (draftPane?.itemId !== itemId) return { ok: false, reason: { kind: 'aborted' } };
	if (!result.ok) return result;
	return { ok: true };
}

/**
 * Send the open draft as a reply. Passes the live buffer so the server
 * sees the user's latest edits without an extra PATCH first. On success
 * the inbox item transitions to `userAction: 'replied'` — the pane is
 * closed by the component, the list refresh moves the item out of
 * Needs-You.
 */
export async function sendOpenPaneDraft(
	currentBuffer: string,
): Promise<
	{ ok: true; messageId: string } | { ok: false; reason: SendReplyFailure }
> {
	const pane = draftPane;
	if (!pane || !pane.draft) return { ok: false, reason: { kind: 'aborted' } };
	const draftId = pane.draft.id;
	const itemId = pane.itemId;
	const result = await apiSendInboxReply(getApiBase(), draftId, currentBuffer);
	if (draftPane?.itemId !== itemId) return { ok: false, reason: { kind: 'aborted' } };
	if (!result.ok) return result;
	// Refresh counts so the badge updates after the item moves zones.
	void loadInboxCounts();
	return { ok: true, messageId: result.sent.messageId };
}

/**
 * Persist a body edit. Caller is responsible for debouncing keystrokes —
 * the store does not coalesce. Returns false on a non-ok response so the
 * caller can keep the local buffer dirty.
 */
export async function saveDraftBody(bodyMd: string): Promise<boolean> {
	const pane = draftPane;
	if (!pane || !pane.draft) return false;
	const draftId = pane.draft.id;
	draftPane = { ...pane, saving: true };
	const updated = await apiUpdateDraft(getApiBase(), draftId, bodyMd);
	if (draftPane?.draft?.id !== draftId) return false;
	if (!updated) {
		draftPane = { ...draftPane, saving: false };
		addToast(t('inbox.draft_error_save'), 'error');
		return false;
	}
	draftPane = {
		...draftPane,
		draft: updated,
		saving: false,
		persistedBody: updated.bodyMd,
	};
	return true;
}
