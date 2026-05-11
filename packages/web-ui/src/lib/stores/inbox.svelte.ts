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
	updateDraft as apiUpdateDraft,
	type GenerateDraftFailure,
	type InboxDraft,
} from '../api/inbox-drafts.js';
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

export async function setItemSnooze(
	id: string,
	until: Date | null,
	condition?: string | null,
	unsnoozeOnReply = true,
): Promise<boolean> {
	const found = findItemAcrossBuckets(id);
	const res = await fetch(`${getApiBase()}/inbox/items/${encodeURIComponent(id)}/snooze`, {
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
