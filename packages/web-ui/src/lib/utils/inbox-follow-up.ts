// === An open item's follow-up line ===
//
// A mail that comes into an item's thread after the item's own mail does not sort the item again:
// its reason and subject still describe the first mail. The list and the reading pane say that
// new mail came, so the reason is not read as describing it. A raised item's line says more
// (the new mail is confidential) and takes the place first.

import { isRaisedOpen, type RaisedCandidate } from './inbox-raised.js';

export interface FollowUpCandidate extends RaisedCandidate {
	followUps?: { count: number } | undefined;
}

type Translate = (key: string) => string;
type TranslateFill = (key: string, vars: Record<string, string>) => string;

/** The list row's line for an item with follow-ups, or undefined when it has none or its raised
 *  line is shown instead. */
export function followUpLine(item: FollowUpCandidate, t: Translate, tf: TranslateFill, now: number = Date.now()): string | undefined {
	const count = item.followUps?.count ?? 0;
	if (count < 1 || isRaisedOpen(item, now)) return undefined;
	return count === 1 ? t('inbox.follow_up_one') : tf('inbox.follow_up_many', { count: String(count) });
}

/** A label that stands for the row (an aria-label hides the row's own text; a title that falls
 *  back to the reason): the follow-up line comes first, so the label does not speak for the new
 *  mail with the first mail's words. The visible row shows the line once, below the headline. */
export function withFollowUpLine(item: FollowUpCandidate, label: string, t: Translate, tf: TranslateFill, now: number = Date.now()): string {
	const line = followUpLine(item, t, tf, now);
	return line === undefined ? label : `${line} · ${label}`;
}
