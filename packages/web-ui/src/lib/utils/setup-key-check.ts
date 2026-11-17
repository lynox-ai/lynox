import { t } from '../i18n.svelte.js';

/**
 * The code `POST /api/secrets/validate-key` sends with its refusal when the instance is connected
 * to a Shopify store and a key the owner typed is not used at all (`PROVIDER_LIST_KEY_CODE` in the
 * engine's `src/server/http-api.ts`; a test holds the two equal).
 */
export const PROVIDER_LIST_KEY_CODE = 'provider_list_own_key';

/** What the key check answered, as the setup banner reads it. */
export interface KeyCheck {
	state: 'valid' | 'invalid' | 'network-error';
	error?: string | undefined;
	code?: string | undefined;
}

/**
 * The sentence the banner shows under the key field for an `invalid` answer: for the store
 * refusal the page's own sentence and its way out, in the page's language (U-307), otherwise
 * the engine's reason, or a fixed one when it gave none.
 */
export function keyCheckError(check: KeyCheck): string {
	if (check.code === PROVIDER_LIST_KEY_CODE) return `${t('setup.key_refused_store')} ${t('setup.key_refused_store_way_out')}`;
	return check.error !== undefined && check.error !== '' ? check.error : 'Invalid API key';
}
