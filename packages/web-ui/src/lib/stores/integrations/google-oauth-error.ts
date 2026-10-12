// === What the Google card says when a connect comes back without a grant ===
//
// The control plane sends the browser back with `?google_oauth_error=<code>`
// (the closed set in `contract/http.ts`), and the BYO callback does the same.
// Pure and rune-free so it can be unit-tested; the card reads the parameter,
// removes it from the URL and shows the notice.

import { isOAuthDeclineCode, type OAuthDeclineCode } from '../../contract/http.js';

export interface GoogleOAuthErrorNotice {
	key: string;
	type: 'info' | 'error';
}

const CANCELLED: GoogleOAuthErrorNotice = { key: 'integrations.google_oauth_cancelled', type: 'info' };
const LINK_STALE: GoogleOAuthErrorNotice = { key: 'integrations.google_oauth_link_stale', type: 'error' };
const FAILED: GoogleOAuthErrorNotice = { key: 'integrations.google_oauth_failed', type: 'error' };

// A Record over the contract union, so a code added there is a type error here
// until it has a notice, instead of falling through to the generic one.
const NOTICE: Record<OAuthDeclineCode, GoogleOAuthErrorNotice> = {
	access_denied: CANCELLED,
	missing_token: FAILED,
	expired: LINK_STALE,
	replayed: LINK_STALE,
	bad_signature: FAILED,
	instance_unbound: FAILED,
	exchange_failed: FAILED,
};

/**
 * The notice for a `google_oauth_error` value, or null when there is none.
 * A value outside the contract set still means the connect did not happen, so
 * it gets the generic failure rather than silence.
 */
export function googleOAuthErrorNotice(raw: string | null): GoogleOAuthErrorNotice | null {
	if (raw === null) return null;
	return isOAuthDeclineCode(raw) ? NOTICE[raw] : FAILED;
}
