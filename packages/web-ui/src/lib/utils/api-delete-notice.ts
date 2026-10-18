/**
 * What a deleted API profile left in the vault, as the settings page says it.
 *
 * The engine's DELETE answer carries the purge lists (`purge` beside `ok`). Each list
 * needs its own sentence: a name kept on purpose, one this vault cannot delete, one the
 * caller could not look at, and one another profile still holds do not share a cause or
 * a next step. Names the purge removed are not repeated; the delete already says that.
 */

export type ApiDeleteNoticeKey =
	| 'apis.delete_no_vault'
	| 'apis.delete_left_kept'
	| 'apis.delete_left_not_removable'
	| 'apis.delete_left_not_visible'
	| 'apis.delete_left_slot_partner'
	| 'apis.delete_left_unreadable';

const LISTS: ReadonlyArray<readonly [string, ApiDeleteNoticeKey]> = [
	['notRemovable', 'apis.delete_left_not_removable'],
	['heldByUnreadable', 'apis.delete_left_unreadable'],
	['heldBySlotPartner', 'apis.delete_left_slot_partner'],
	['notVisible', 'apis.delete_left_not_visible'],
	['kept', 'apis.delete_left_kept'],
];

function names(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string' && n.length > 0) : [];
}

/** One sentence per non-empty list; empty when the answer has no `purge` or nothing stayed.
 *  Without a vault (`noVault`) nothing was checked, and that is the one sentence. */
export function apiDeleteNotice(body: unknown, tf: (key: ApiDeleteNoticeKey, vars: Record<string, string>) => string): string[] {
	if (typeof body !== 'object' || body === null) return [];
	if ((body as { noVault?: unknown }).noVault === true) return [tf('apis.delete_no_vault', {})];
	const purge = (body as { purge?: unknown }).purge;
	if (typeof purge !== 'object' || purge === null) return [];
	const lines: string[] = [];
	for (const [field, key] of LISTS) {
		const list = names((purge as Record<string, unknown>)[field]);
		if (list.length > 0) lines.push(tf(key, { names: list.join(', ') }));
	}
	return lines;
}
