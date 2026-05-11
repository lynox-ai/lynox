// Account ids are either mail-account cuids or `whatsapp:<phoneNumberId>`
// pseudo-ids set by the WA adapter. Both are opaque to the UI — the trailing
// segment after a colon gives enough visual disambiguation for the inbox
// surfaces; the full id stays available as a `title` attribute / tooltip.

export function accountShortLabel(accountId: string): string {
	const colonIdx = accountId.indexOf(':');
	return colonIdx >= 0 ? accountId.slice(colonIdx + 1) : accountId;
}
