// === Calendar accounts HTTP client ===
//
// Typed wrapper around `/api/calendar/*`. CalendarSettings consumes it for
// the multi-step wizard (preset list + add + test + delete + set-default).
// `apiBase` is passed in so the file has no `$state` import and can be
// tested directly. Shapes match `CalendarContext.listAccounts()` +
// `addAccount()` + `testAccount()` in the engine.

export type CalDavPresetSlug =
	| 'icloud' | 'fastmail' | 'nextcloud' | 'mailbox-org'
	| 'posteo' | 'zoho-eu' | 'zoho-us' | 'yahoo';

export type DataResidency = 'EU' | 'US' | 'AU' | 'user-controlled';

export interface CalDavPreset {
	slug: CalDavPresetSlug;
	display_name: string;
	server_url: string | undefined;
	auth_style: 'basic' | 'app-password';
	skip_discovery: boolean;
	data_residency: DataResidency;
	app_password_help_url: string | undefined;
}

export interface CalendarAccountView {
	id: string;
	provider: 'caldav' | 'ics-feed';
	display_name: string;
	is_default_writable: boolean;
	data_residency?: DataResidency;
	has_credentials: boolean;
	server_url?: string;
	username?: string;
	preset_slug?: CalDavPresetSlug | 'custom';
	poll_interval_minutes?: number;
	enabled_calendars?: string[];
	default_calendar?: string;
}

export interface TestAccountResult {
	ok: boolean;
	error?: string;
	code?: string;
}

export interface AddCalDavInput {
	provider: 'caldav';
	display_name: string;
	preset_slug: CalDavPresetSlug | 'custom';
	server_url?: string;
	username: string;
	password: string;
	enabled_calendars?: string[];
	is_default_writable?: boolean;
}

export interface AddIcsInput {
	provider: 'ics-feed';
	display_name: string;
	ics_url: string;
	poll_interval_minutes?: number;
}

export type AddAccountInput = AddCalDavInput | AddIcsInput;

export async function listCalDavPresets(apiBase: string): Promise<CalDavPreset[]> {
	const res = await fetch(`${apiBase}/calendar/presets`);
	if (!res.ok) return [];
	const data = (await res.json()) as { presets?: CalDavPreset[] };
	return Array.isArray(data.presets) ? data.presets : [];
}

export async function listCalendarAccounts(apiBase: string): Promise<CalendarAccountView[]> {
	const res = await fetch(`${apiBase}/calendar/accounts`);
	if (!res.ok) return [];
	const data = (await res.json()) as { accounts?: CalendarAccountView[] };
	return Array.isArray(data.accounts) ? data.accounts : [];
}

export async function addCalendarAccount(
	apiBase: string,
	input: AddAccountInput,
): Promise<{ ok: true; account: CalendarAccountView } | { ok: false; error: string }> {
	const res = await fetch(`${apiBase}/calendar/accounts`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input),
	});
	const body = (await res.json().catch(() => ({}))) as { ok?: boolean; account?: CalendarAccountView; error?: string };
	if (!res.ok || body.ok === false) return { ok: false, error: body.error ?? `HTTP ${res.status}` };
	if (!body.account) return { ok: false, error: 'Response missing account' };
	return { ok: true, account: body.account };
}

export async function testCalendarAccount(
	apiBase: string,
	input: AddAccountInput,
): Promise<TestAccountResult> {
	const res = await fetch(`${apiBase}/calendar/accounts/test`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(input),
	});
	if (res.status === 429) {
		return { ok: false, error: 'Rate limit exceeded — bitte 1 Minute warten', code: 'rate_limited' };
	}
	return (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as TestAccountResult;
}

export async function deleteCalendarAccount(apiBase: string, id: string): Promise<boolean> {
	const res = await fetch(`${apiBase}/calendar/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
	return res.ok;
}

export async function setDefaultWritableAccount(apiBase: string, id: string): Promise<boolean> {
	const res = await fetch(`${apiBase}/calendar/accounts/${encodeURIComponent(id)}/default`, { method: 'POST' });
	return res.ok;
}
