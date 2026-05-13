// === Inbox notification preferences HTTP client ===
//
// `GET/PATCH /api/inbox/notification-prefs` — single envelope so the UI
// loads once and PATCHes deltas. Backend defaults the missing fields to
// the same values shown here so the UI never has to special-case empty.

export interface NotificationPrefsAccount {
	id: string;
	displayName: string;
	address: string;
	muted: boolean;
}

export interface NotificationPrefsQuietHours {
	enabled: boolean;
	start: string; // HH:MM
	end: string; // HH:MM
	tz: string; // IANA
}

export interface NotificationPrefs {
	inboxPushEnabled: boolean;
	quietHours: NotificationPrefsQuietHours;
	perMinute: number;
	perHour: number;
	accounts: ReadonlyArray<NotificationPrefsAccount>;
}

export interface NotificationPrefsPatch {
	inboxPushEnabled?: boolean | undefined;
	quietHours?: Partial<NotificationPrefsQuietHours> | undefined;
	perMinute?: number | undefined;
	perHour?: number | undefined;
	/** Map of accountId → muted; keys absent are left unchanged. */
	accounts?: Record<string, boolean> | undefined;
}

function normalisePrefs(raw: Partial<NotificationPrefs>): NotificationPrefs {
	return {
		inboxPushEnabled: raw.inboxPushEnabled !== false,
		quietHours: {
			enabled: raw.quietHours?.enabled === true,
			start: raw.quietHours?.start ?? '22:00',
			end: raw.quietHours?.end ?? '07:00',
			tz: raw.quietHours?.tz ?? 'UTC',
		},
		perMinute: typeof raw.perMinute === 'number' && raw.perMinute > 0 ? raw.perMinute : 1,
		perHour: typeof raw.perHour === 'number' && raw.perHour > 0 ? raw.perHour : 10,
		accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
	};
}

export async function getNotificationPrefs(apiBase: string): Promise<NotificationPrefs | null> {
	try {
		const res = await fetch(`${apiBase}/inbox/notification-prefs`);
		if (!res.ok) return null;
		return normalisePrefs((await res.json()) as Partial<NotificationPrefs>);
	} catch {
		return null;
	}
}

export async function updateNotificationPrefs(
	apiBase: string,
	patch: NotificationPrefsPatch,
): Promise<NotificationPrefs | null> {
	try {
		const res = await fetch(`${apiBase}/inbox/notification-prefs`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch),
		});
		if (!res.ok) return null;
		return normalisePrefs((await res.json()) as Partial<NotificationPrefs>);
	} catch {
		return null;
	}
}
