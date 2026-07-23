// === Pure helpers: the hybrid PER-TIER provider/model picker ===
//
// Extracted from `LLMSettings.svelte` (same pattern as `llm-main-model.ts` /
// `llm-routing-update.ts`) so the tier_models sourcing, the managed
// availability gating, and the preset→custom seeding are unit-testable without
// a Svelte runtime.
//
// Background: a catalog entry with `models: []` is a FREE-TEXT tile (the user
// types the model id — core catalog.ts documents why). That correctly excluded
// such entries from the per-tier picker, but it also excluded Fireworks, whose
// two preset-slot models ARE measured and engine-supported as raw tier_set
// slots. Core now ships them as `tier_models` — per-tier picker options ONLY,
// the tile stays free-text — and these helpers source the picker from that
// field without touching the `models: []` semantics.

/** The model fields the picker needs (structural subset of a catalog model). */
export interface TierPickerModel {
	id: string;
	tier?: string;
	label: string;
	pricing?: { input: number; output: number };
}

/** The catalog-entry fields the picker needs (structural subset). */
export interface TierPickerEntry {
	provider: string;
	models: TierPickerModel[];
	/** Per-tier picker options for a free-text tile (core `tier_models`). */
	tier_models?: TierPickerModel[];
}

/** One preset tier row from the GET /api/config `available_tier_presets` signal. */
export interface PresetTierLike {
	tier: string;
	model_id: string;
}
export interface PresetInfoLike {
	available: boolean;
	tiers: PresetTierLike[];
}

type EditorTier = 'fast' | 'balanced' | 'deep';

/**
 * The models the per-tier dropdown offers for an entry: the tiered catalog when
 * one exists, else the entry's pinned `tier_models`. Never both — `tier_models`
 * exists precisely for entries whose `models` is the free-text `[]`. Generic so
 * a caller's richer model type (the component's `CatalogModel`) flows through.
 */
export function tierPickerModels<M extends TierPickerModel>(
	entry: { models: M[]; tier_models?: M[] },
): M[] {
	return entry.models.length > 0 ? entry.models : (entry.tier_models ?? []);
}

/**
 * Default model id for a tier within an entry's picker models: the first model
 * tagged with that tier, falling back to the first model overall. `tier_models`
 * entries carry NO tier tag (preset-slot models — no measured tier map), so
 * they always resolve via the first-entry fallback, which is the deliberate
 * "no fake band" default. '' when the entry offers nothing.
 */
export function defaultTierModelId(entry: TierPickerEntry, tier: EditorTier): string {
	const models = tierPickerModels(entry);
	return (models.find((m) => m.tier === tier) ?? models[0])?.id ?? '';
}

/**
 * Managed gating for a tier_models-only entry: the CP demonstrably backs one of
 * the entry's models — i.e. some preset the server marked `available` routes a
 * slot through it. `available` is computed server-side with the SAME loader
 * hardening that decides whether a raw slot is kept at config-load
 * (`applyManagedTierSetConstraints`), so this can never advertise an option the
 * loader would drop or the write-gate would 403. Fail-closed: no evidence → not
 * offered.
 */
export function cpBacksTierModels(
	entry: TierPickerEntry,
	availablePresets: Record<string, PresetInfoLike>,
): boolean {
	const ids = new Set((entry.tier_models ?? []).map((m) => m.id));
	if (ids.size === 0) return false;
	return Object.values(availablePresets).some(
		(p) => p.available && p.tiers.some((t) => ids.has(t.model_id)),
	);
}

/**
 * Is this catalog entry offered as a PROVIDER option in the per-tier editor?
 *  - Vertex is retired in-product → never.
 *  - A tiered catalog (`models.length > 0`) → always (Anthropic, Mistral).
 *  - A free-text tile with `tier_models` → yes on self-host/BYOK (keys via the
 *    entry's own vault slot); on a CP-supplied instance only when the CP
 *    demonstrably backs it (see {@link cpBacksTierModels}) — otherwise picking
 *    it could only produce an honest 403 on save, which is a dead-end option.
 *  - A free-text tile without `tier_models` (openai-compat, custom, Ollama, …)
 *    → no: a per-tier free-text field is out of scope for the editor.
 */
export function isHybridTierOption(
	entry: TierPickerEntry,
	opts: { cpSuppliesKey: boolean; availablePresets: Record<string, PresetInfoLike> },
): boolean {
	if (entry.provider === 'vertex') return false;
	if (entry.models.length > 0) return true;
	if ((entry.tier_models?.length ?? 0) === 0) return false;
	return !opts.cpSuppliesKey || cpBacksTierModels(entry, opts.availablePresets);
}

/**
 * Seed the "custom" per-tier editor from an active preset's resolved tiers (the
 * GET /api/config `available_tier_presets` rows carry each slot's `model_id`).
 * A tier maps to the first offered provider option whose picker models contain
 * that model; a tier whose model no option carries is omitted (the caller's
 * default seeding covers it). So switching preset → custom starts from the
 * preset's actual models instead of provider defaults.
 */
export function presetTierSeed(
	preset: PresetInfoLike | undefined,
	options: ReadonlyArray<{ key: string; entry: TierPickerEntry }>,
): Partial<Record<EditorTier, { catalogKey: string; modelId: string }>> {
	const out: Partial<Record<EditorTier, { catalogKey: string; modelId: string }>> = {};
	for (const t of preset?.tiers ?? []) {
		if (t.tier !== 'fast' && t.tier !== 'balanced' && t.tier !== 'deep') continue;
		const match = options.find((o) => tierPickerModels(o.entry).some((m) => m.id === t.model_id));
		if (match) out[t.tier] = { catalogKey: match.key, modelId: t.model_id };
	}
	return out;
}
