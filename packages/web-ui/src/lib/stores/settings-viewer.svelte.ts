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

/** True only when the server said this session is a mandate's. */
export function isMandateSession(): boolean {
	return viewer === 'mandate';
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
	viewer = null;
	pending = null;
}
