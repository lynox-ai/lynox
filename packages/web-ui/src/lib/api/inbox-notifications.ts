// === Inbox notification preferences HTTP client ===
//
// `GET/PATCH /api/inbox/notification-prefs` — single boolean today
// (`inboxPushEnabled`). The user-visible point is decoupling
// "subscribe device" (browser push subscription) from "fire on new
// mail" (this preference). Reminders + Send-Later failure pings live
// on a separate path and ignore this toggle.

export interface NotificationPrefs {
	inboxPushEnabled: boolean;
}

export async function getNotificationPrefs(apiBase: string): Promise<NotificationPrefs | null> {
	try {
		const res = await fetch(`${apiBase}/inbox/notification-prefs`);
		if (!res.ok) return null;
		const data = (await res.json()) as Partial<NotificationPrefs>;
		return { inboxPushEnabled: data.inboxPushEnabled !== false };
	} catch {
		return null;
	}
}

export async function updateNotificationPrefs(
	apiBase: string,
	patch: Partial<NotificationPrefs>,
): Promise<NotificationPrefs | null> {
	try {
		const res = await fetch(`${apiBase}/inbox/notification-prefs`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(patch),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as Partial<NotificationPrefs>;
		return { inboxPushEnabled: data.inboxPushEnabled !== false };
	} catch {
		return null;
	}
}
