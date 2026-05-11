// === Mail accounts HTTP client ===
//
// Pure fetcher around `/api/mail/accounts`. RulesView consumes it to
// populate the account picker. `apiBase` is passed in so the file has
// no `$state` import and can be tested directly. Wire shape matches
// `MailContext.listAccounts()` from the engine.

export interface MailAccountView {
	id: string;
	displayName: string;
	address: string;
	preset: string;
	isDefault: boolean;
	type: string;
	authType: string;
}

export async function listMailAccounts(apiBase: string): Promise<MailAccountView[] | null> {
	try {
		const res = await fetch(`${apiBase}/mail/accounts`);
		if (!res.ok) return null;
		const data = (await res.json()) as { accounts?: MailAccountView[] };
		return Array.isArray(data.accounts) ? data.accounts : [];
	} catch {
		return null;
	}
}
