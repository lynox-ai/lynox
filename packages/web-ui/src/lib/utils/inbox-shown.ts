// === The mail a delivery failure notice's row shows ===
//
// An item a delivery failure notice created keeps the notice as its own mail: its sender, subject
// and Message-ID stay those of the notice, and the reading pane shows the notice's text. When a
// real mail comes into the thread after it, the API adds `shown`, taken from that one mail, and the
// list row names it instead of the notice. Nothing else changes.
//
// A shown mail that reads as sensitive comes without name and subject: the row shows its address
// and, in the subject's place, the mark the list puts on a confidential mail.

import { inboxHeadline } from './inbox-headline.js';

type Translate = (key: string) => string;

export interface ShownCandidate {
	fromAddress: string;
	fromName?: string | undefined;
	subject?: string | undefined;
	snippet?: string | undefined;
	reasonDe?: string | undefined;
	mailDate?: string | undefined;
	classifiedAt: string;
	shown?: {
		id: string;
		fromAddress: string;
		fromName?: string | undefined;
		subject?: string | undefined;
		messageId: string;
		mailDate?: string | undefined;
		sensitive: boolean;
	} | undefined;
}

/** The row's headline: the shown mail's subject where there is one, else the item's. */
export function rowHeadline(item: ShownCandidate, t: Translate): string {
	const shown = item.shown;
	if (shown === undefined) return inboxHeadline(item);
	if (shown.sensitive) return t('inbox.sensitive_mark');
	return inboxHeadline({ subject: shown.subject });
}

/** The row's label text where it stands for the mail: the shown subject (or the sensitive mark),
 *  else the item's subject, else its reason. */
export function rowLabel(item: ShownCandidate, t: Translate): string {
	const shown = item.shown;
	if (shown === undefined) return item.subject?.trim() || (item.reasonDe ?? '');
	return rowHeadline(item, t);
}

/** The row's sender: the shown mail's name or address (never a name when it is sensitive). */
export function rowSender(item: ShownCandidate): { label: string; address: string } {
	const shown = item.shown;
	if (shown !== undefined) {
		const name = shown.sensitive ? undefined : shown.fromName?.trim();
		return { label: name !== undefined && name.length > 0 ? name : shown.fromAddress, address: shown.fromAddress };
	}
	return { label: item.fromName || item.fromAddress, address: item.fromAddress };
}

/** The row's own date, before any follow-up line moves it: the shown mail's where it has one. */
export function rowOwnDate(item: ShownCandidate): string {
	return item.shown?.mailDate ?? item.mailDate ?? item.classifiedAt;
}

/** Whether the row carries the confidential mark for its shown mail. */
export function shownIsSensitive(item: ShownCandidate): boolean {
	return item.shown?.sensitive === true;
}

/**
 * "Reply in chat" on an item whose row shows another mail than its own: the framing names no
 * value of that mail. The chat answers the newest follow-up of the thread, which is the shown mail,
 * and the server's context for the item names its sender, subject and text inside its untrusted
 * frame. Undefined for any other item, whose framing stays as it is.
 */
export function shownReplyFraming(item: ShownCandidate, t: Translate): string | undefined {
	return item.shown === undefined ? undefined : t('inbox.reply_in_chat_prompt_newest');
}
