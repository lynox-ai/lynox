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

/** The form fields that make up an account payload. */
export interface MailAccountFormFields {
	id: string;
	displayName: string;
	address: string;
	preset: string;
	type: string;
	password: string;
	personaPrompt: string;
	custom?: unknown;
}

/**
 * Build the POST body for `/mail/accounts` and `/mail/accounts/test`.
 *
 * Shared on purpose. These two payloads were built separately in MailSettings
 * and had drifted: the test button sent `type` and `personaPrompt`, the save
 * button did not. The server defaults a missing type to 'personal'
 * (`isValidAccountType(rawType) ? rawType : 'personal'`), so an account created
 * as Business came back Personal — with a different send policy and persona than
 * the one chosen — while a connection test beforehand looked entirely correct.
 * One builder means the save path cannot silently carry less than the test path.
 *
 * `type` is REQUIRED on the input on purpose: dropping it at a call site is then a
 * compile error under `web-ui-typecheck` (a required check), which is what actually
 * guards the two callers. A unit test here can only pin the builder.
 */
export function buildMailAccountPayload(f: MailAccountFormFields): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		id: f.id,
		displayName: f.displayName,
		address: f.address,
		preset: f.preset,
		type: f.type,
		credentials: { user: f.address, pass: f.password },
	};
	if (f.personaPrompt.trim()) payload['personaPrompt'] = f.personaPrompt.trim();
	if (f.preset === 'custom' && f.custom !== undefined) payload['custom'] = f.custom;
	return payload;
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
