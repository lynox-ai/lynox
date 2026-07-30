// Out-of-tab attention signal for a pending human prompt (ask_user / tool consent).
//
// When a run parks on a prompt while the tab is HIDDEN, nothing today tells the
// user that lynox is waiting for THEM — a run can sit unanswered for tens of
// minutes and read as "stuck" or "looping" (2026-07-25: a prod thread parked 32
// and 40 minutes on an ask_user and a bash-consent prompt; the user perceived a
// loop). The in-tab `PromptAnchor` bar covers the looking-at-the-tab case; this
// covers the away / other-tab case with a title-bar badge and — only if
// notification permission is ALREADY granted — one browser notification per
// pending prompt.
//
// Invariants: never REQUEST permission (that is the push/settings flow's job);
// never fire while the tab is visible; never spam (one notification per prompt,
// keyed to dedupe). All DOM/Notification access is guarded for SSR.

let originalTitle: string | null = null;
let activeKey: string | null = null;
let notif: Notification | null = null;
let badgeLabel = '';
let visHandler: (() => void) | null = null;

/** Apply or restore the title badge based on the current visibility + pending state. */
function syncTitle(): void {
	if (typeof document === 'undefined') return;
	if (activeKey !== null && document.hidden) {
		if (originalTitle === null) originalTitle = document.title;
		document.title = `● ${badgeLabel}`;
	} else if (originalTitle !== null) {
		document.title = originalTitle;
		originalTitle = null;
	}
}

function onVisibilityChange(): void {
	syncTitle();
	// The user is back on the tab — the in-tab anchor now carries the signal, so
	// dismiss the OS-level notification (leaving the run's prompt untouched).
	if (typeof document !== 'undefined' && !document.hidden) {
		notif?.close();
		notif = null;
	}
}

/**
 * Reconcile the attention signal with the current pending prompt.
 * @param key   Stable identity of the pending prompt (promptId or a fallback), or
 *              `null` when no prompt is pending. A changed non-null key is a NEW
 *              prompt (fires at most one fresh notification).
 */
export function setPromptAttention(
	key: string | null,
	labels: { badge: string; notifyTitle: string; notifyBody: string },
): void {
	if (typeof window === 'undefined') return;

	if (key === null) { clearPromptAttention(); return; }
	// Same prompt still pending → nothing to do (dedupe: no re-notify, no title churn).
	if (key === activeKey) return;

	activeKey = key;
	badgeLabel = labels.badge;
	if (!visHandler && typeof document !== 'undefined') {
		visHandler = onVisibilityChange;
		document.addEventListener('visibilitychange', visHandler);
	}
	syncTitle();

	// One browser notification, only when the tab is hidden AND permission is
	// already granted. Never requested here; never shown while the user is looking.
	if (
		typeof document !== 'undefined' && document.hidden &&
		typeof Notification !== 'undefined' && Notification.permission === 'granted'
	) {
		try {
			notif?.close();
			notif = new Notification(labels.notifyTitle, { body: labels.notifyBody, tag: 'lynox-pending-prompt' });
			notif.onclick = () => { window.focus(); notif?.close(); };
		} catch { /* Notification ctor can throw on some platforms — non-critical */ }
	}
}

/** Clear the badge + notification + listener. Idempotent; safe on unmount. */
export function clearPromptAttention(): void {
	activeKey = null;
	if (typeof document !== 'undefined' && originalTitle !== null) {
		document.title = originalTitle;
		originalTitle = null;
	}
	notif?.close();
	notif = null;
	if (visHandler && typeof document !== 'undefined') {
		document.removeEventListener('visibilitychange', visHandler);
		visHandler = null;
	}
}
