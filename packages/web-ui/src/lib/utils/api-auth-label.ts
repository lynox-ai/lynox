import { presetProviderLabel } from './preset-provider-label.js';

/**
 * What the chip in an API profile's card head says about how the profile signs in, as an i18n key
 * with its values, or `null` for no chip. The profile's auth type is the engine's word for it
 * (`bearer`, `oauth2`, …), which tells a reader nothing; the chip names the way instead. A profile
 * without sign-in, or with a type this page does not know, gets no chip rather than the raw word.
 */
export type AuthChipLabel = { key: string; values?: Record<string, string> };

const KEY_TYPES = new Set(['bearer', 'header', 'query']);

export function authChipLabel(auth: { type: string; oauth?: { preset_id?: string } } | undefined): AuthChipLabel | null {
	if (!auth) return null;
	if (auth.type === 'oauth2') {
		const preset = auth.oauth?.preset_id;
		// The provider by its display name, never the preset's raw id.
		return typeof preset === 'string' && preset !== ''
			? { key: 'apis.auth_signin_via', values: { provider: presetProviderLabel(preset) } }
			: { key: 'apis.auth_signin_provider' };
	}
	if (KEY_TYPES.has(auth.type)) return { key: 'apis.auth_api_key' };
	if (auth.type === 'basic') return { key: 'apis.auth_basic' };
	return null;
}
