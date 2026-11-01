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

/** Takes `viewer` from a `GET /api/config` body a page has read anyway. */
export function noteSettingsViewer(body: unknown): void {
	if (body === null || typeof body !== 'object' || !('viewer' in body)) return;
	const v = (body as { viewer: unknown }).viewer;
	if (v === 'owner' || v === 'mandate' || v === 'none') viewer = v;
}

/** Reads `viewer` once per page load; later calls share the first. */
export function loadSettingsViewer(): Promise<void> {
	if (viewer !== null) return Promise.resolve();
	const asked = generation;
	pending ??= (async () => {
		let answered = false;
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (res.ok) {
				const body: unknown = await res.json();
				if (asked !== generation) return;
				answered = true;
				noteSettingsViewer(body);
			}
		} catch {
			// No answer: the owner's fields stay, and the server refuses what it must.
		} finally {
			if (asked === generation) pending = null;
		}
		if (asked !== generation) return;
		// An answer without `viewer` (an older engine) is not asked again; no answer is.
		if (!answered && viewer === null && retries < RETRY_MS.length && retryTimer === null) {
			retryTimer = setTimeout(() => { retryTimer = null; void loadSettingsViewer(); }, RETRY_MS[retries++]);
		}
	})();
	return pending;
}

/** Forget what was read: before a new sign-in, and in tests. */
export function resetSettingsViewer(): void {
	generation++;
	viewer = null;
	pending = null;
	retries = 0;
	if (retryTimer !== null) clearTimeout(retryTimer);
	retryTimer = null;
}
