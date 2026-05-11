// === Mail accounts HTTP client ===
//
// `GET /api/mail/accounts` returns the no-secrets view of every
// registered mail account. RulesView consumes it to populate the
// account picker. Kept as a pure fetcher (no `$state`) so the surface
// stays scoped to whoever needs it.

import { getApiBase } from '../config.svelte.js';

/**
 * Wire shape exposed by the engine via `MailContext.listAccounts()` —
 * the secret-free subset. We only need id/displayName/address for the
 * UI dropdown today; the wider type is documented for future fields.
 */
export interface MailAccountSummary {
	id: string;
	displayName: string;
	address: string;
	preset: string;
	isDefault: boolean;
	type: string;
	authType: string;
}

export async function listMailAccounts(): Promise<MailAccountSummary[] | null> {
	try {
		const res = await fetch(`${getApiBase()}/mail/accounts`);
		if (!res.ok) return null;
		const data = (await res.json()) as { accounts?: MailAccountSummary[] };
		return Array.isArray(data.accounts) ? data.accounts : [];
	} catch {
		return null;
	}
}
