// === The owner's bulk-runs switch on the tool-permissions page (UX-031) ===
// Reads what `GET /api/config` says about bulk runs (`bulk_runs`, written in core's http-api from
// `core/bulk-switch.ts`) and decides what the switch shows. The engine stays the judge: the switch
// shows `on` as the engine runs it, and a write the engine does not act on changes nothing here.

/** `bulk_runs` from `GET /api/config`. Absent on an engine older than the field. */
export interface BulkRunsConfig {
	on: boolean;
	source: 'config' | 'control-plane';
	allowed: boolean;
	shopify: boolean;
}

export interface BulkRunsView {
	/** The switch's position: whether bulk runs run on this instance right now. */
	on: boolean;
	/** Why the switch is locked, as an i18n key, or null when the owner may switch it. */
	lockedKey: string | null;
	/** What to do about the lock, as an i18n key, or null (the pool tier's lock names it already). */
	lockedNextKey: string | null;
	/** The extra line when bulk runs are on but a Shopify store cannot be read in one, or null. */
	shopifyKey: string | null;
}

function isBulkRunsConfig(v: unknown): v is BulkRunsConfig {
	if (typeof v !== 'object' || v === null) return false;
	const r = v as Record<string, unknown>;
	return typeof r['on'] === 'boolean'
		&& (r['source'] === 'config' || r['source'] === 'control-plane')
		&& typeof r['allowed'] === 'boolean'
		&& typeof r['shopify'] === 'boolean';
}

/**
 * What the switch shows for a `GET /api/config` answer, or null when the answer carries no
 * readable `bulk_runs` (then the section is not shown at all). `managed` is the answer's tier
 * field: set means the instance is hosted, the same test the contained-chat line reads.
 */
export function bulkRunsView(config: unknown): BulkRunsView | null {
	if (typeof config !== 'object' || config === null) return null;
	const c = config as Record<string, unknown>;
	const bulk = c['bulk_runs'];
	if (!isBulkRunsConfig(bulk)) return null;
	const managed = typeof c['managed'] === 'string' && c['managed'] !== '';
	// Locked only where turning bulk runs on would not take effect. Turning them off is always
	// the owner's, but a locked switch is already off: without `allowed` no ledger runs.
	const lockedKey = bulk.allowed
		? null
		: bulk.source === 'control-plane' ? 'bulk.setting.locked_pool' : 'bulk.setting.locked_db';
	// No engine database means it failed to open at boot (`EngineDb init failed`), not a setting.
	const lockedNextKey = lockedKey === 'bulk.setting.locked_db'
		? (managed ? 'bulk.setting.locked_db_managed' : 'bulk.setting.locked_db_selfhost')
		: null;
	const shopifyKey = bulk.on && !bulk.shopify
		? (managed ? 'bulk.setting.shopify_managed' : 'bulk.setting.shopify_selfhost')
		: null;
	return { on: bulk.on, lockedKey, lockedNextKey, shopifyKey };
}
