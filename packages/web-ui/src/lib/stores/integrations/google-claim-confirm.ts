/**
 * The text of the dialog that asks before a Google claim is taken.
 *
 * With the account known, the dialog names it, and the user can see whose
 * account a link they were sent would connect. Without it (an older control
 * plane, a grant without the `openid email` scopes, a failed lookup), the
 * dialog says it cannot name the account. It never claims more than it knows.
 */
export interface ClaimConfirmCopy {
	readonly key: string;
	readonly hintKey: string;
	readonly vars: Record<string, string>;
}

export function claimConfirmCopy(email: string | null): ClaimConfirmCopy {
	if (email !== null && email !== '') {
		return {
			key: 'settings.google.claim_confirm_named',
			hintKey: 'settings.google.claim_confirm_named_hint',
			vars: { email },
		};
	}
	return { key: 'settings.google.claim_confirm', hintKey: 'settings.google.claim_confirm_hint', vars: {} };
}
