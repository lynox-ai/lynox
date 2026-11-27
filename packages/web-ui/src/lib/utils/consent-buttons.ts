import type { ConsentAction, ConsentKey, ConsentKind } from '../contract/prompt.js';

/**
 * The buttons of a tool's confirmation card (mail, Google, memory, plan): each sends its key,
 * and only the label is in the page's language. The guard and the deep consent keep their own
 * cards. How a button looks says what it does: the action itself, in red when it deletes or
 * retires, and cancelling as the quiet one.
 */
export type ConsentTone = 'primary' | 'danger' | 'secondary';

export interface ConsentButton {
	readonly key: ConsentKey;
	/** The i18n key of its label. */
	readonly label: string;
	readonly tone: ConsentTone;
}

/** The kinds drawn by this card: a tool's own confirmation, its question rendered as markdown. */
export type ToolConsentKind = Exclude<ConsentKind, 'guard' | 'deep'>;

export function isToolConsent(kind: ConsentKind | undefined): kind is ToolConsentKind {
	return kind !== undefined && kind !== 'guard' && kind !== 'deep';
}

const CANCEL: ConsentButton = { key: 'cancel', label: 'chat.consent_cancel', tone: 'secondary' };

export function consentButtons(kind: ToolConsentKind, action?: ConsentAction): ConsentButton[] {
	switch (kind) {
		case 'send': return [{ key: 'send', label: 'chat.consent.send', tone: 'primary' }, CANCEL];
		case 'google': return [{
			key: 'confirm',
			label: action !== undefined ? `chat.consent.action.${action}` : 'chat.consent.confirm',
			tone: action === 'delete' ? 'danger' : 'primary',
		}, CANCEL];
		case 'merge': return [{ key: 'merge', label: 'chat.consent.merge', tone: 'primary' }, CANCEL];
		case 'apply': return [{ key: 'apply', label: 'chat.consent.apply', tone: 'primary' }, CANCEL];
		case 'retire': return [{ key: 'retire', label: 'chat.consent.retire', tone: 'danger' }, CANCEL];
		case 'plan': return [
			{ key: 'proceed', label: 'chat.consent.proceed', tone: 'primary' },
			{ key: 'adjust', label: 'chat.consent.adjust', tone: 'secondary' },
			CANCEL,
		];
	}
}
