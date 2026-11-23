/**
 * What the chip in an API profile's card head says about how the profile signs in, as an i18n key
 * with its values, or `null` for no chip. The profile's auth type is the engine's word for it
 * (`bearer`, `oauth2`, …), which tells a reader nothing; the chip names the way instead. A profile
 * without sign-in, or with a type this page does not know, gets no chip rather than the raw word.
 *
 * `builtInProvider` is the engine's answer (`built_in_provider` in the profile list): the display
 * name of the built-in provider the profile signs in through, or null. The stored `preset_id` is
 * not used, because it is checked for its form only: an id the engine does not know would read as
 * a provider sign-in it never does.
 */
export type AuthChipLabel = { key: string; values?: Record<string, string> };

const KEY_TYPES = new Set(['bearer', 'header', 'query']);

export function authChipLabel(auth: { type: string } | undefined, builtInProvider: string | null | undefined): AuthChipLabel | null {
	if (!auth) return null;
	if (auth.type === 'oauth2') {
		return typeof builtInProvider === 'string' && builtInProvider !== ''
			? { key: 'apis.auth_signin_via', values: { provider: builtInProvider } }
			: { key: 'apis.auth_signin_provider' };
	}
	if (KEY_TYPES.has(auth.type)) return { key: 'apis.auth_api_key' };
	if (auth.type === 'basic') return { key: 'apis.auth_basic' };
	return null;
}
