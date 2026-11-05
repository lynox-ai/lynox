/**
 * The status bar's line for a boot in which engine.db or history.db did not open (U-162).
 *
 * The engine puts `boot_stores_missing` on the providers poll for the owner only, and
 * `boot_stores_alerted` when a control plane runs the instance (its health monitor alerts on the
 * degraded engine). One line: a sentence per missing store, then one closing sentence for the mode,
 * so the way out is not said twice when both are missing.
 */

export type BootStore = 'engine.db' | 'history.db';

const STORE_KEY: Record<BootStore, string> = {
	'engine.db': 'status.boot_store_missing_engine',
	'history.db': 'status.boot_store_missing_history',
};

/** The stores the poll names, in a fixed order; anything else in the field is ignored. */
export function bootStoresOf(value: unknown): BootStore[] {
	if (!Array.isArray(value)) return [];
	return (['engine.db', 'history.db'] as const).filter((s) => value.includes(s));
}

/** The i18n keys of the line, in order; empty when nothing is missing. */
export function bootStoreLineKeys(missing: readonly BootStore[], alerted: boolean): string[] {
	if (missing.length === 0) return [];
	return [
		...missing.map((s) => STORE_KEY[s]),
		alerted ? 'status.boot_store_missing_managed' : 'status.boot_store_missing_selfhost',
	];
}
