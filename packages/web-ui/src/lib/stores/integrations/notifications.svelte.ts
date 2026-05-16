// === Integrations: push-notification prefs ===
//
// Owns the Inbox push-notification preference cluster from IntegrationsView:
//  - `prefs` (NotificationPrefs) fetched from `/api/inbox/notifications/prefs`
//  - Serialised PATCH chain so two near-simultaneous toggles don't race
//  - Throttle-input sanitiser that drops NaN
//  - Browser-TZ fallback used when first enabling quiet-hours
//
// NOTE: this is the *prefs* surface — the Service-Worker subscribe / permission
// lifecycle lives in `../notifications.svelte.ts` and is not re-implemented here.
// The original IntegrationsView used both, and the channel route will too.
//
// Foundation for P3-PR-A1. Zero behaviour change — straight port from
// IntegrationsView.svelte:25-76.

import { getApiBase } from '../../config.svelte.js';
import { t } from '../../i18n.svelte.js';
import { addToast } from '../toast.svelte.js';
import {
	getNotificationPrefs,
	updateNotificationPrefs,
	type NotificationPrefs,
	type NotificationPrefsPatch,
} from '../../api/inbox-notifications.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let prefs = $state<NotificationPrefs | null>(null);

// Serialise PATCHes so two near-simultaneous toggles don't race — the
// second wait-for-first chain ensures we always merge against the freshest
// server state, never a stale `prev` snapshot.
let inFlight: Promise<void> = Promise.resolve();

// ---------------------------------------------------------------------------
// Getter
// ---------------------------------------------------------------------------

export function getPrefs(): NotificationPrefs | null {
	return prefs;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function loadInboxPushPref(): Promise<void> {
	prefs = await getNotificationPrefs(getApiBase());
}

export async function patchPrefs(patch: NotificationPrefsPatch): Promise<void> {
	const run = async (): Promise<void> => {
		const prev = prefs;
		if (prev) {
			prefs = {
				...prev,
				...(patch.inboxPushEnabled !== undefined
					? { inboxPushEnabled: patch.inboxPushEnabled }
					: {}),
				...(patch.perMinute !== undefined ? { perMinute: patch.perMinute } : {}),
				...(patch.perHour !== undefined ? { perHour: patch.perHour } : {}),
				...(patch.quietHours
					? { quietHours: { ...prev.quietHours, ...patch.quietHours } }
					: {}),
				...(patch.accounts
					? {
							accounts: prev.accounts.map((a) =>
								patch.accounts && a.id in patch.accounts
									? { ...a, muted: patch.accounts[a.id]! }
									: a,
							),
						}
					: {}),
			};
		}
		const result = await updateNotificationPrefs(getApiBase(), patch);
		if (result) {
			prefs = result;
		} else {
			prefs = prev;
			addToast(t('integrations.push_inbox_save_failed'), 'error');
		}
	};
	inFlight = inFlight.then(run, run);
	await inFlight;
}

/** Drop NaN before it taints optimistic state — `parseInt('')` returns NaN. */
export function patchThrottle(field: 'perMinute' | 'perHour', raw: string): void {
	const n = parseInt(raw, 10);
	if (!Number.isFinite(n)) return;
	void patchPrefs({ [field]: n } as NotificationPrefsPatch);
}

export function defaultBrowserTz(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}
