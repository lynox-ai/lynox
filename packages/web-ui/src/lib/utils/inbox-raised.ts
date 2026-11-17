// === A raised item's "back here" line ===
//
// The engine raises an item to "requires you" when a flagged message arrives in its thread
// (`raiseToRequiresUser`), and marks it with this classifier version. The list says why it is
// back while the item stays open there; the owner's next action or snooze ends it, and the engine
// then changes the version, so a later reopen does not say it again.

export const RAISED_CLASSIFIER_VERSION = 'sensitive-follow-up';

export interface RaisedCandidate {
	classifierVersion: string;
	userAction?: string | undefined;
	snoozeUntil?: string | undefined;
}

export function isRaisedOpen(item: RaisedCandidate, now: number = Date.now()): boolean {
	if (item.classifierVersion !== RAISED_CLASSIFIER_VERSION) return false;
	if (item.userAction !== undefined) return false;
	return !(item.snoozeUntil !== undefined && Date.parse(item.snoozeUntil) > now);
}
