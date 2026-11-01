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
/** Whether `GET /api/config` named a `locks.provider`; null until a body was read. */
let providerLocked = $state<boolean | null>(null);
let pending: Promise<void> | null = null;

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
	if (v === 'owner' || v === 'mandate' || v === 'none') viewer = v;
	// Every `GET /api/config` body carries `locks`; one without it says nothing about the lock, so
	// the line that needs it stays hidden rather than assuming there is none.
	const locks = (body as { locks?: unknown }).locks;
	providerLocked = locks !== null && typeof locks === 'object' ? ((locks as { provider?: unknown }).provider ?? null) !== null : null;
}

/** Reads `viewer` once per page load; later calls share the first. */
export function loadSettingsViewer(): Promise<void> {
	if (viewer !== null) return Promise.resolve();
	pending ??= (async () => {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (res.ok) noteSettingsViewer(await res.json());
		} catch {
			// No answer: the owner's fields stay, and the server refuses what it must.
		} finally {
			pending = null;
		}
	})();
	return pending;
}

/** For tests: forget what was read. */
export function resetSettingsViewer(): void {
	// `providerLocked` needs no reset: every body that sets `viewer` also sets it.
	viewer = null;
	pending = null;
}
