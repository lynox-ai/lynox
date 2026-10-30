import type { ClaimPreview } from './google.svelte.js';

/**
 * What the dialog that asks before a Google claim is taken shows, for each
 * state of the account lookup.
 *
 * - still looking: says so, and Connect waits;
 * - named: names the account, and Connect is offered;
 * - unnamed: the control plane answered and the grant names no account. Whoever
 *   runs the consent can arrange that, so Connect is not offered at all. The way
 *   out differs with `connected`: an instance with Google connected shows no
 *   Connect button, so its hint says to disconnect first;
 * - unknown (no answer to go by): says it cannot name the account, and leaves the
 *   decision to the user, as before the lookup existed.
 *
 * The sentence is split around the address so the component can set the address
 * apart (`<bdi>`), rather than letting it run into the text.
 */
export interface ClaimConfirmCopy {
	readonly before: string;
	readonly email: string | null;
	readonly after: string;
	readonly hintKey: string;
	readonly confirm: 'enabled' | 'disabled' | 'hidden';
}

const SLOT = '{email}';

export function claimConfirmCopy(preview: ClaimPreview | null, translate: (key: string) => string, connected = false): ClaimConfirmCopy {
	if (preview === null) {
		return { before: translate('settings.google.claim_looking'), email: null, after: '', hintKey: 'settings.google.claim_confirm_hint', confirm: 'disabled' };
	}
	if (preview.kind === 'named') {
		const template = translate('settings.google.claim_confirm_named');
		const at = template.indexOf(SLOT);
		return {
			before: at < 0 ? template : template.slice(0, at),
			email: preview.email,
			after: at < 0 ? '' : template.slice(at + SLOT.length),
			hintKey: 'settings.google.claim_confirm_named_hint',
			confirm: 'enabled',
		};
	}
	if (preview.kind === 'unnamed') {
		const hintKey = connected ? 'settings.google.claim_unnamed_hint_connected' : 'settings.google.claim_unnamed_hint';
		return { before: translate('settings.google.claim_unnamed'), email: null, after: '', hintKey, confirm: 'hidden' };
	}
	return { before: translate('settings.google.claim_confirm'), email: null, after: '', hintKey: 'settings.google.claim_confirm_hint', confirm: 'enabled' };
}
