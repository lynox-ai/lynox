import { addToast } from '../stores/toast.svelte.js';
import { t } from '../i18n.svelte.js';

/**
 * Copy text and say whether it worked. `navigator.clipboard.writeText` rejects without permission,
 * outside a secure context, or when the page has no focus; a bare call followed by "Copied" then
 * tells the user something that did not happen. This never rejects.
 */
export async function copyWithToast(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		addToast(t('common.copy_failed'), 'error', 4000);
		return false;
	}
	addToast(t('common.copied'), 'success', 1500);
	return true;
}
