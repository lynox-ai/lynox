// === Whose session the settings pages serve ===
//
// `PUT /api/config` is the owner's: a mandate's session is refused with "Only the owner of this
// instance can change the configuration". So the settings pages show a mandate the values as text,
// under a sentence that the owner sets them (ux U-104), instead of fields it cannot save.
// `GET /api/config` says whose session asks (`viewer`). It is read once and shared by every page.
//
// When the answer is missing or unknown, the pages show the owner's fields. The server stays the
// boundary either way: a mandate that gets the fields still has its save refused, and the refusal
// says why (`api/save-refusal.ts`).

import { getApiBase } from '../config.svelte.js';

export type SettingsViewer = 'owner' | 'mandate' | 'none';

let viewer = $state<SettingsViewer | null>(null);
/**
 * Whether `viewer` is known, kept outside the reactive state: a page asks from an effect, and an
 * effect that read `viewer` would run again when the answer arrives and reload what it loads
 * alongside.
 */
let known = false;
/** Whether `GET /api/config` named a `locks.provider`; null until a body was read. */
let providerLocked = $state<boolean | null>(null);
let pending: Promise<void> | null = null;

/**
 * When `GET /api/config` gives no answer, it is asked again after these waits. The pages ask once,
 * when they mount, and the owner's actions wait for the answer: without a retry the owner of a page
 * already open would not see them until a reload, and nothing would say why.
 */
const RETRY_MS = [1_000, 3_000, 10_000];
let retries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by a reset, so an answer asked for before it is not taken after it. */
let generation = 0;
/** Every try went unanswered: the pages say so once, instead of standing there without the owner's actions. */
let unavailable = $state(false);

/** True only when the server said this session is a mandate's. */
export function isMandateSession(): boolean {
	return viewer === 'mandate';
}

/**
 * True only when the server said this session is the owner's. For something the owner starts and
 * a mandate must not even see for a moment (the introduction in an empty chat): it stays hidden
 * while the answer is out, and when there is none.
 */
export function isOwnerSession(): boolean {
	return viewer === 'owner';
}

/** True only after the first request and every retry got no answer (ux U-117). */
export function isViewerUnavailable(): boolean {
	return unavailable;
}

/**
 * True only when the server said this session is the owner's AND named no `locks.provider`: the
 * one who can pick another main model under Settings › Configuration › Model strategy. For a line
 * that points there (the thinking-loop note, ux U-116): hidden while the answer is out, and when
 * there is none, so it never points a mandate or a locked instance at a choice it does not have.
 */
export function canChooseModel(): boolean {
	return viewer === 'owner' && providerLocked === false;
}

/** Takes `viewer` and whether the provider is locked from a `GET /api/config` body a page has read anyway. */
export function noteSettingsViewer(body: unknown): void {
	if (body === null || typeof body !== 'object' || !('viewer' in body)) return;
	const v = (body as { viewer: unknown }).viewer;
	if (v === 'owner' || v === 'mandate' || v === 'none') { viewer = v; known = true; unavailable = false; }
	// Every `GET /api/config` body carries `locks`; one without it says nothing about the lock, so
	// the line that needs it stays hidden rather than assuming there is none.
	const locks = (body as { locks?: unknown }).locks;
	providerLocked = locks !== null && typeof locks === 'object' ? ((locks as { provider?: unknown }).provider ?? null) !== null : null;
}

/** Reads `viewer` once per page load; later calls share the first. */
export function loadSettingsViewer(): Promise<void> {
	if (known) return Promise.resolve();
	const asked = generation;
	pending ??= (async () => {
		let answered = false;
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (res.ok) {
				const body: unknown = await res.json();
				if (asked !== generation) return;
				answered = true;
				// An answer, even one without `viewer` (an older engine), means the page did load.
				unavailable = false;
				noteSettingsViewer(body);
			}
		} catch {
			// No answer: the owner's fields stay, and the server refuses what it must.
		} finally {
			if (asked === generation) pending = null;
		}
		if (asked !== generation) return;
		// An answer without `viewer` (an older engine) is not asked again; no answer is.
		if (answered || known) return;
		// A retry still waiting will ask again: only with none left is the answer unavailable.
		if (retryTimer !== null) return;
		if (retries < RETRY_MS.length) {
			retryTimer = setTimeout(() => { retryTimer = null; void loadSettingsViewer(); }, RETRY_MS[retries++]);
		} else {
			unavailable = true;
		}
	})();
	return pending;
}

/** Forget what was read: before a new sign-in, and in tests. */
export function resetSettingsViewer(): void {
	generation++;
	// `providerLocked` needs no reset: every body that sets `viewer` also sets it.
	viewer = null;
	known = false;
	unavailable = false;
	pending = null;
	retries = 0;
	if (retryTimer !== null) clearTimeout(retryTimer);
	retryTimer = null;
}
