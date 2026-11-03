/**
 * What the page says about a chat that only reads (`contained`), as i18n keys.
 *
 * Enforcement does not change here: the engine counts a chat as contained also when it cannot
 * read whether the chat read store data (engine.db unreadable, or a provisioned instance without
 * the record). Then it adds `contained_unknown`, and the page must not say the chat read store
 * data: it says the check failed, that this holds for every chat, and where to look — support on
 * an instance the control plane set up, the instance's logs on a self-hosted one.
 */

/** Why a chat counts as contained although its record could not be read, and so where to look. */
export type ContainedUnknown = 'provisioned' | 'self-hosted';

/** `contained_unknown` from the engine, or null for a value it does not send. */
export function readContainedUnknown(value: unknown): ContainedUnknown | null {
	return value === 'provisioned' || value === 'self-hosted' ? value : null;
}

/** The places that name the read-only state. */
export type ContainedSlot = 'locked' | 'badge' | 'bar' | 'error';

const KNOWN: Record<ContainedSlot, string> = {
	locked: 'threads.contained_locked',
	badge: 'threads.contained_badge',
	bar: 'contained.bar',
	error: 'threads.error_contained',
};

const UNKNOWN: Record<ContainedSlot, string> = {
	locked: 'threads.contained_locked_unknown',
	badge: 'threads.contained_badge_unknown',
	bar: 'contained.bar_unknown',
	error: 'threads.error_contained_unknown',
};

/** The keys for `slot`, joined with a space when shown. A failed check names where to look, except
 *  in the badge, which is too short for it. */
export function containedTextKeys(slot: ContainedSlot, unknown: ContainedUnknown | null): string[] {
	if (unknown === null) return [KNOWN[slot]];
	if (slot === 'badge') return [UNKNOWN.badge];
	return [UNKNOWN[slot], unknown === 'provisioned' ? 'contained.unknown_way_support' : 'contained.unknown_way_logs'];
}
