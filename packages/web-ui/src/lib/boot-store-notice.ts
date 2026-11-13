/**
 * The status bar's line for a boot in which engine.db or history.db did not open.
 *
 * The engine puts `boot_stores_missing` on the providers poll for the owner only, and
 * `boot_stores_alerted` when a control plane runs the instance (its health monitor alerts on the
 * degraded engine), and `boot_store_memory_old` when durable memory was on and did not load for want
 * of engine.db. One line in paragraphs: one per missing store, then one closing paragraph for the
 * mode, so the way out is not said twice when both are missing.
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

/**
 * The sentence for one missing store. engine.db has a second sentence when durable memory did not load;
 * history.db has a managed one, because a managed instance always sets the daily and monthly caps and so
 * never runs a chat without history.db, where self-host does once both caps are removed.
 */
function storeKey(store: BootStore, alerted: boolean, memoryOld: boolean): string {
	if (store === 'engine.db' && memoryOld) return 'status.boot_store_missing_engine_memory';
	if (store === 'history.db' && alerted) return 'status.boot_store_missing_history_managed';
	return STORE_KEY[store];
}

/**
 * The i18n keys of the line, as paragraphs: one per missing store, then the closing one; empty when
 * nothing is missing. `memoryOld` picks the engine.db sentence that also says memory is an old state
 * and access cannot sign in: that holds only when durable memory was on and did not load for want of
 * engine.db; with durable memory off both are the normal state and the sentence leaves them out.
 */
export function bootStoreLineKeys(missing: readonly BootStore[], alerted: boolean, memoryOld = false): string[][] {
	if (missing.length === 0) return [];
	return [
		...missing.map((s) => [storeKey(s, alerted, memoryOld)]),
		[alerted ? 'status.boot_store_missing_managed' : 'status.boot_store_missing_selfhost'],
	];
}
