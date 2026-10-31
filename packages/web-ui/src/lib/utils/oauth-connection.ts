/**
 * Who connected an OAuth profile and with which provider account, as the profile list shows it.
 *
 * The engine records both on the profile's grant (`oauth_grant.connected_by`, the principal tag
 * of the consent, and `oauth_grant.account`, the account it signed in with). A helper can connect
 * a profile with their own login, and then the tokens point at their account, not the customer's:
 * this is where the customer reads that.
 *
 * Nothing here decides anything. An account the engine did not record is shown as unknown, never
 * guessed from the profile. An account the engine left out for this reader (`account_withheld`)
 * is shown as not shown. Whether the reader made the connection is the engine's answer
 * (`connected_by_reader`), not read from the tag: the page does not know who reads it.
 */

const MANDATE_TAG_PREFIX = 'mandate:';

export interface OAuthGrantView {
	connected_by?: unknown;
	account?: { label?: unknown } | undefined;
	account_withheld?: unknown;
	connected_by_reader?: unknown;
}

export type ConnectedBy = { kind: 'you' } | { kind: 'owner' } | { kind: 'helper'; address: string } | { kind: 'other'; tag: string };

export interface ConnectionLine {
	by: ConnectedBy;
	/** The account label, or null when the engine recorded none or left it out ({@link withheld}). */
	account: string | null;
	/** The engine left the account out for this reader. */
	withheld: boolean;
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
	const withheld = grant.account_withheld === true;
	const account = !withheld && typeof label === 'string' && label !== '' ? label : null;
	if (tag === undefined && account === null && !withheld) return null;
	// "You" only when the engine says this reader gave the consent; without that answer it is
	// never "you". Otherwise the owner's tag (or none, from before it was recorded) is the owner's,
	// and any other tag is named as it is, so a consent that was not the owner's never reads as theirs.
	const by: ConnectedBy = grant.connected_by_reader === true
		? { kind: 'you' }
		: tag === undefined || tag === 'owner'
		? { kind: 'owner' }
		: typeof tag === 'string' && tag.startsWith(MANDATE_TAG_PREFIX) && tag.length > MANDATE_TAG_PREFIX.length
			? { kind: 'helper', address: tag.slice(MANDATE_TAG_PREFIX.length) }
			: { kind: 'other', tag: String(tag) };
	return { by, account, withheld };
}
