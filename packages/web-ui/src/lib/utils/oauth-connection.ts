/**
 * Who connected an OAuth profile and with which provider account, as the profile list shows it.
 *
 * The engine records both on the profile's grant (`oauth_grant.connected_by`, the principal tag
 * of the consent, and `oauth_grant.account`, the account it signed in with). A helper can connect
 * a profile with their own login, and then the tokens point at their account, not the customer's:
 * this is where the customer reads that.
 *
 * Nothing here decides anything. An account the engine did not record is shown as unknown, never
 * guessed from the profile.
 */

const MANDATE_TAG_PREFIX = 'mandate:';

export interface OAuthGrantView {
	connected_by?: unknown;
	account?: { label?: unknown } | undefined;
}

export type ConnectedBy = { kind: 'you' } | { kind: 'helper'; address: string } | { kind: 'other'; tag: string };

export interface ConnectionLine {
	by: ConnectedBy;
	/** The account label, or null when the engine recorded none. */
	account: string | null;
}

/**
 * The line for a profile's connection, or null when it was never connected (no consent on
 * record). A grant from before `connected_by` was recorded reads as the owner's, as it does in
 * the engine.
 */
export function connectionLine(grant: OAuthGrantView | undefined): ConnectionLine | null {
	if (grant === undefined || grant === null) return null;
	const tag = grant.connected_by;
	const label = grant.account?.label;
	const account = typeof label === 'string' && label !== '' ? label : null;
	if (tag === undefined && account === null) return null;
	// Only the owner's tag (or none, from before it was recorded) is "you". Any other tag is
	// named as it is, so a consent that was not the owner's never reads as theirs.
	const by: ConnectedBy = tag === undefined || tag === 'owner'
		? { kind: 'you' }
		: typeof tag === 'string' && tag.startsWith(MANDATE_TAG_PREFIX) && tag.length > MANDATE_TAG_PREFIX.length
			? { kind: 'helper', address: tag.slice(MANDATE_TAG_PREFIX.length) }
			: { kind: 'other', tag: String(tag) };
	return { by, account };
}
