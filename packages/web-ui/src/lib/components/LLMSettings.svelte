<!--
	LLM Settings — provider + key + model + test (PRD-SETTINGS-REFACTOR Phase 2
	Principle 3: provider + model unified in one flow). Replaces the old
	Settings → Provider tab. Capability-gated via /api/config.locks.provider
	on managed tiers.

	Per-provider keys persist in vault under their canonical names
	(ANTHROPIC_API_KEY, MISTRAL_API_KEY, OPENAI_API_KEY) — switching providers
	does NOT delete keys, so users can flip back without re-entering.

	Tier-awareness audit (Settings v3 Item 2, 2026-05-19; api_base_url row
	corrected 2026-06-07 — BYOK CAN set a custom endpoint, gated by the
	disclosure modal, NOT blocked):
	| Setting               | Self-host | BYOK | Managed |
	|-----------------------|-----------|------|---------|
	| provider tile pick    | ✓         | ✓    | ✓ curated allowlist (Anthropic + Mistral) |
	| api_key field         | ✓         | ✓    | ✗ CP supplies → hidden |
	| api_base_url (custom) | ✓         | ✓ (disclosure-gated) | ✗ locks.custom_provider_endpoints |
	| gcp_project_id/region | ✓         | ✗    | ✗ vertex retired in-product |
	| default_tier          | ✓         | ✓    | ✓        |
	| custom_endpoints reg. | ✓         | ✓    | ✗ locks.custom_endpoints |
	| Test-connection btn   | ✓         | ✓    | ✗ hidden (CP key, no test surface) |
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { buildLLMConfigUpdate } from '../utils/llm-config-update.js';
	import { clearTierConfigCache } from '../utils/tier-config.js';
	import { buildMainModelOptions, selectMainModelKey, mainModelOptionKey, findMainModelOptionByKey, isExpensiveModel, type MainChatOption, type MainModelOption } from '../utils/llm-main-model.js';
	import { isAllowlistedEndpoint, disclosureHostname } from '../utils/endpoint-disclosure.js';
	import { isProviderTileLocked } from '../utils/llm-tile-lock.js';
	import { isManaged, cpSuppliesLLMKeyForInstance, loadManagedStatus } from '../stores/integrations/managed.svelte.js';
	import LLMAdvancedView from './LLMAdvancedView.svelte';
	import Icon from '../primitives/Icon.svelte';
	import type { IconName } from '../primitives/icons.js';
	import { buildRoutingUpdate, type Strategy } from '../utils/llm-routing-update.js';
	// Shared vocabulary from the vendored wire-contract copy (byte-identical to
	// core `src/contract/vocab.ts`) — replaces the old local enum mirrors.
	import type { LLMProvider, ModelTier } from '../contract/vocab.js';

	interface CatalogModel {
		id: string;
		tier?: string;
		label: string;
		context_window: number;
		pricing?: { input: number; output: number };
		residency: string;
		notes?: string;
	}
	// MainChatOption (the server-computed catalog.ts `main_chat_models` shape) +
	// the picker helpers live in ../utils/llm-main-model.js — imported above.
	interface CatalogProvider {
		provider: LLMProvider;
		/**
		 * UI-only disambiguator when multiple entries share `provider` (e.g.
		 * Mistral + generic OpenAI-compatible both serialise to `'openai'`).
		 * When omitted, the entry's `provider` is its UI identity.
		 */
		preset_id?: string;
		display_name: string;
		models: CatalogModel[];
		/** Standard-mode "Main chat model" picker options (server-computed). */
		main_chat_models?: MainChatOption[];
		requires_base_url: boolean;
		requires_region: boolean;
		default_residency: string;
		/** Pre-filled api_base_url for presets that pin a fixed endpoint. */
		base_url_default?: string;
		/**
		 * How far the entry is proven (server-side `catalog.ts`). 'experimental'
		 * means tool-calling through it is NOT verified — lynox is an agent, so
		 * that is a real caveat and the tile must say so. Optional here only to
		 * stay tolerant of an older engine that predates the field.
		 */
		verification?: 'native' | 'verified' | 'experimental';
		/**
		 * Vault slot this entry's key lives in. `null` = endpoint takes no credential
		 * (loopback runtime) → render no key field at all. `undefined` = older engine
		 * that predates the field → fall back to the provider map.
		 */
		vault_slot?: string | null;
		/** Example model id for the free-text field an empty-catalog entry renders. */
		model_placeholder?: string;
		notes?: string;
	}

	function catalogEntryKey(entry: CatalogProvider): string {
		return entry.preset_id ?? entry.provider;
	}

	interface CustomEndpoint { id: string; name: string; base_url: string }

	// Provider-agnostic routing (PR-4). Canonical tier band — the catalog and
	// the engine both speak 'fast' | 'balanced' | 'deep' (legacy haiku/sonnet/opus
	// only survive as normaliser input; `ModelTier` imported from the contract
	// copy above). Display + iteration order is cheap→deep.
	const TIER_ORDER: ReadonlyArray<ModelTier> = ['fast', 'balanced', 'deep'];

	// One tier's provider+model assignment in a hybrid Tier-Set. Mirrors
	// core/src/types/config.ts TierSlot (web-ui can't import core — see the
	// type-mirror note at the top of this script). PR-4 Increment 1 only sets
	// {provider, model_id} for the active provider; per-slot creds + cross-
	// provider mixing land in Increment 2.
	interface TierSlot { provider: string; model_id: string; api_key?: string; api_base_url?: string }
	type TierSet = Partial<Record<ModelTier, TierSlot>>;

	interface UserConfig {
		provider?: LLMProvider;
		api_base_url?: string;
		gcp_project_id?: string;
		gcp_region?: string;
		default_tier?: string;
		// Served-Sonnet variant the Anthropic `balanced` band resolves to (4.6 ↔ 5).
		// GET /api/config always sends a resolved value (defaults to Sonnet 4.6).
		balanced_model?: string;
		// CP-emitted tier ceiling (env → seed as a lock). Options above it render
		// disabled with a tooltip. Vestigial today (managed + hosted both 'deep'),
		// kept as the safety seam so a future lower ceiling greys correctly.
		max_tier?: string;
		openai_model_id?: string;
		custom_endpoints?: CustomEndpoint[];
		// 'standard' (default) = one provider for all tiers (lynox routes per task
		// via the fixed MODEL_MAP). 'hybrid' = each tier resolves via `tier_set`.
		routing_mode?: 'standard' | 'hybrid';
		// Per-tier {provider, model_id} — only consulted by the engine when
		// routing_mode === 'hybrid'. An unset tier falls back to the base provider.
		tier_set?: TierSet;
		// Named hybrid strategy (model-presets W4). Config-sugar: the engine expands
		// it to {routing_mode:'hybrid', tier_set} at load. Returned verbatim by GET,
		// so the "Modell-Strategie" cards read it to highlight the active preset.
		tier_preset?: string;
		// Server-persisted disclosure acceptances for non-allowlisted custom
		// endpoints (host + timestamp). Read from /api/config; replaces the old
		// per-tab sessionStorage flag so acceptance survives reload / new device.
		accepted_custom_endpoints?: { host: string; accepted_at: string }[];
		// Self-host: env vars that override on-disk config every time the engine
		// reloads. If `env_overrides.provider` is true, the user picking a
		// different provider tile + Save will succeed against config.json but
		// have zero runtime effect because `LYNOX_LLM_PROVIDER` keeps winning
		// on the next reload. Surface this so we can render a banner instead
		// of accepting the click in silence (found during demo-walk hardening
		// while verifying a provider switch — turned the fix into a silent no-op
		// under the env-recommending docs path).
		env_overrides?: { provider?: boolean };
		// F1b: effective active provider + base, surfaced ONLY when env-pinned
		// (the provider then never lands in config.json, so `provider` /
		// `api_base_url` above are empty). Used as a fallback to highlight the
		// right tile — without it an env-pinned Mistral tenant defaults to
		// 'anthropic' and shows the wrong provider selected (staging-walk F1b).
		active_provider?: { provider?: LLMProvider; api_base_url?: string };
		// CP-managed flag from /api/config ('managed' | 'managed_pro' | 'eu' | …).
		// Selects the env-override banner copy: managed users can't touch .env, so
		// the self-host remediation is noise for them (staging-walk finding F2).
		managed?: string;
		// Advanced + Memory + Context-Window have moved to /settings/llm/advanced
		// and /settings/llm/memory (PRD-IA-V2 P3-PR-C). The fields stay on
		// /api/config (same SSoT) but live on their own surfaces; this page
		// owns only Provider + Key + Model + Custom-Endpoint Registry.
	}

	interface Locks {
		// Legacy hard-lock: operator pinned a provider in config.json (rare).
		// When set, NO provider tile is clickable.
		provider?: { reason: string; upgrade_cta?: { href: string; label: string } };
		// P3-FOLLOWUP-HOTFIX: Managed lock on free-text endpoints. Curated tiles
		// (Anthropic, Mistral preset) stay clickable; tiles with
		// `requires_base_url === true` (OpenAI-compat, Anthropic-compat) are
		// disabled.
		custom_provider_endpoints?: { reason: string };
		// model-presets W4: set on managed when the CP can't back a preset (e.g. ⚡
		// efficient's Fireworks slot without the operator opt-in) → that card renders
		// disabled with the contact CTA rather than silently downgrading.
		tier_preset?: { reason: string; contact_cta?: { href: string; label: string } };
	}

	// The GET /api/config `available_tier_presets` signal (server-authoritative;
	// web-ui can't import @lynox-ai/core). Per preset: the resolved per-tier model
	// (+ catalog label + provenance + R2-gated host disclosure) and whether the
	// instance can back it (managed drops a preset whose slot the CP lacks a key for).
	interface PresetTierInfo {
		tier: ModelTier;
		model_id: string;
		label: string;
		provenance?: 'US' | 'EU' | 'CN';
		residency?: string;
		transferBasis?: string | null;
		posture?: string;
		pricing?: { input: number; output: number };
	}
	interface PresetInfo {
		name: string;
		tiers: PresetTierInfo[];
		available: boolean;
	}
	// The five strategy cards. 'standard' = one provider, lynox routes per turn;
	// the three preset names are hybrid tier_presets; 'custom' = manual hybrid.
	// `Strategy` + `buildRoutingUpdate` (the persistence mapping) live in a plain
	// .ts helper so the body-building is unit-testable (this .svelte has no seam).
	const PRESET_NAMES: ReadonlyArray<'efficient' | 'balanced' | 'max-quality'> = ['efficient', 'balanced', 'max-quality'];

	let providers = $state<CatalogProvider[]>([]);
	let config = $state<UserConfig>({});
	let locks = $state<Locks>({});
	let activeProvider = $state<LLMProvider | null>(null);
	// UI key of the active catalog entry — disambiguates entries that share
	// `provider` (e.g. mistral vs. generic openai-compat). Stays in sync with
	// `activeProvider` on selection; on load, derived from config (Mistral
	// host → 'mistral'; otherwise the provider id).
	let activeCatalogKey = $state<string | null>(null);
	// Tracks whether `provider` was explicitly set in ~/.lynox/config.json
	// (vs. defaulted to 'anthropic' in `load()`). PRD-IA-V2 P1-PR-A1 empty-state
	// CTA must fire on first-paint of a fresh config, before the user picks.
	let providerExplicit = $state(false);
	// Per-provider key cache (UI-only — kept in vault, sent on save).
	let keys = $state<Record<string, string>>({});
	let loaded = $state(false);
	let testing = $state(false);
	let saving = $state(false);
	// PR 4.6: deferred mount of embedded LLMAdvancedView — avoids the duplicate
	// /api/config fetch until the user actually expands the section.
	let advancedOpen = $state(false);
	let testResult = $state<{ ok: boolean; latency_ms?: number; message?: string } | null>(null);
	// Live `/api/secrets/status` snapshot — drives the empty-state predicate
	// alongside the explicit-provider flag. Both must be false to show the CTA.
	let apiKeyConfigured = $state<boolean | null>(null);

	// Provider-agnostic routing (PR-4). `routingMode` mirrors config.routing_mode.
	// In hybrid each tier picks its OWN provider + model, so `tierSlots` holds a
	// {catalogKey, modelId} pair per tier (catalogKey = the provider tile's UI key,
	// e.g. 'anthropic' | 'mistral'). Hydrated in load(); the API key for each
	// provider lives in the vault (entered below), never in the persisted tier_set.
	let routingMode = $state<'standard' | 'hybrid'>('standard');
	let tierSlots = $state<Record<ModelTier, { catalogKey: string; modelId: string }>>({
		fast: { catalogKey: '', modelId: '' },
		balanced: { catalogKey: '', modelId: '' },
		deep: { catalogKey: '', modelId: '' },
	});

	// ── model-presets W4 — "Modell-Strategie" cards ──
	// `strategy` is the selected card; it drives routingMode + what persists.
	// Derived from config on load (a stored tier_preset → that card; else hybrid →
	// 'custom'; else 'standard'). The card the user clicks stages locally (no
	// auto-save — rafael's explicit-save model); Save materializes it.
	let strategy = $state<Strategy>('standard');
	// Server signal: which presets exist + their resolved tiers + availability.
	let availablePresets = $state<Record<string, PresetInfo>>({});
	// Per-card "Details" expand state (the full three-axis disclosure).
	let expandedDetails = $state<Record<string, boolean>>({});
	// Explicit-save model (rafael): every change stages `dirty`; the Save button
	// commits, the "Ungespeicherte Änderungen" bar shows meanwhile. No auto-save.
	let dirty = $state(false);
	function markDirty(): void { if (loaded) dirty = true; }

	// Vault slot per provider — keeps existing keys when user switches.
	// Each provider has a DISTINCT slot so flipping anthropic → custom → anthropic
	// doesn't clobber the original Anthropic key. Vertex has no slot (auth is
	// GCP-OAuth via env / service-account) — we render the GCP fields instead.
	const VAULT_SLOTS: Record<LLMProvider, string | null> = {
		anthropic: 'ANTHROPIC_API_KEY',
		vertex: null,
		openai: 'MISTRAL_API_KEY',  // catalog label is "Mistral (OpenAI-compat)" — slot matches that semantic
		custom: 'CUSTOM_API_KEY',
	};
	function slotFor(p: LLMProvider | null): string {
		if (!p) return '';
		return VAULT_SLOTS[p] ?? '';
	}
	/**
	 * The vault slot for a CATALOG ENTRY — the authoritative one. `provider` alone
	 * cannot decide it: Mistral, Groq, Together and a local Ollama all serialise to
	 * `provider: 'openai'`, so a provider-keyed lookup would write a Groq key into
	 * the Mistral slot (and hand the Mistral key to Groq on the next request).
	 * Mirrors `vaultSlotForEndpoint` in core/src/core/llm/catalog.ts.
	 *
	 * Returns '' when the endpoint needs no credential (loopback) — callers use
	 * that to hide the key field entirely.
	 */
	function slotForEntry(entry: CatalogProvider | null | undefined): string {
		if (!entry) return '';
		if (entry.vault_slot === null) return '';
		return entry.vault_slot ?? slotFor(entry.provider);
	}

	/**
	 * Disambiguate which preset matches a persisted (provider, api_base_url)
	 * pair. Mirrors `resolveCatalogKey` in core/src/core/llm/catalog.ts —
	 * web-ui keeps its own copy because the file architecture forbids
	 * direct core imports (avoids dist/ rebuild churn; see the type-mirror
	 * comment at the top of this script). The pure-TS twin in catalog.ts
	 * has the unit test coverage; keep both in lockstep on changes.
	 *
	 * Hostname-based match (URL parser, NOT substring) so a misconfigured
	 * api_base_url like `https://attacker.example.com/?proxy=mistral.ai`
	 * cannot accidentally activate the Mistral preset. Apex/api/subdomain
	 * all match the registered preset; foreign-host suffixes do not.
	 *
	 * EXCEPT for loopback presets: Ollama (:11434), LM Studio (:1234), vLLM
	 * (:8000) and LocalAI (:8080) all share the hostname `localhost` and are
	 * told apart only by port. Matching on hostname alone resolves every one of
	 * them to whichever sits first in the catalog, so a user who saved LM Studio
	 * would come back to the Ollama tile. Compare host:port for those.
	 *
	 * Fallback order: single-entry → that entry; multi-preset without a
	 * match → the `requires_base_url` preset (so the user sees the input
	 * they need to fill in); else first candidate.
	 */
	function isLoopbackHost(hostname: string): boolean {
		return hostname === 'localhost'
			|| hostname === '127.0.0.1'
			|| hostname === '0.0.0.0'
			|| hostname === '[::1]'
			|| hostname === '::1';
	}

	function resolveCatalogKey(provider: LLMProvider, baseUrl?: string): string {
		const candidates = providers.filter((p) => p.provider === provider);
		if (candidates.length === 0) return provider;
		if (candidates.length === 1) return catalogEntryKey(candidates[0]!);
		if (baseUrl) {
			let host = '';
			let hostPort = '';
			try {
				const u = new URL(baseUrl);
				host = u.hostname.toLowerCase();
				hostPort = u.host.toLowerCase();
			} catch { /* invalid — falls through to the generic tile */ }
			if (host) {
				const matched = candidates.find((c) => {
					if (!c.base_url_default) return false;
					let defHost = '';
					let defHostPort = '';
					try {
						const d = new URL(c.base_url_default);
						defHost = d.hostname.toLowerCase();
						defHostPort = d.host.toLowerCase();
					} catch { return false; }
					// Loopback: only the port distinguishes the runtimes. A non-default
					// port falls through to the generic tile, which is the safe direction.
					if (isLoopbackHost(defHost)) return hostPort === defHostPort;
					if (host === defHost) return true;
					const apex = defHost.replace(/^api\./, '');
					return host === apex || host.endsWith(`.${apex}`);
				});
				if (matched) return catalogEntryKey(matched);
			}
		}
		const generic = candidates.find((c) => c.requires_base_url);
		return catalogEntryKey(generic ?? candidates[0]!);
	}

	async function load(): Promise<void> {
		try {
			const [catRes, configRes, statusRes] = await Promise.all([
				fetch(`${getApiBase()}/llm/catalog`),
				fetch(`${getApiBase()}/config`),
				fetch(`${getApiBase()}/secrets/status`),
			]);
			if (!catRes.ok || !configRes.ok) throw new Error(`HTTP ${catRes.status} / ${configRes.status}`);
			const catBody = (await catRes.json()) as { providers: CatalogProvider[] };
			providers = catBody.providers;
			const configBody = (await configRes.json()) as UserConfig & { locks?: Locks; available_tier_presets?: Record<string, PresetInfo> };
			config = configBody;
			locks = configBody.locks ?? {};
			availablePresets = configBody.available_tier_presets ?? {};
			// F1b: when env-pinned the provider isn't on disk, so fall back to the
			// effective `active_provider` the engine surfaces. An env-pinned
			// provider IS an explicit choice (just made via env) → count it for
			// providerExplicit so the empty-state CTA doesn't wrongly appear.
			const effProvider = configBody.active_provider;
			providerExplicit = (typeof configBody.provider === 'string' && configBody.provider.length > 0)
				|| typeof effProvider?.provider === 'string';
			activeProvider = configBody.provider ?? effProvider?.provider ?? 'anthropic';
			// Pick the matching catalog entry. For providers with multiple
			// presets (openai → mistral + openai-compat) we disambiguate from
			// the saved api_base_url: a Mistral host activates the Mistral
			// preset, anything else falls through to the generic OpenAI-compat
			// entry. Keeps round-trip consistent so a returning user lands on
			// the same button they last picked.
			// F1b: fall back to the effective base URL too, so an env-pinned
			// Mistral tenant (api_base_url not on disk) resolves the Mistral
			// preset instead of the generic OpenAI-compat tile.
			activeCatalogKey = resolveCatalogKey(activeProvider, configBody.api_base_url ?? effProvider?.api_base_url);
			// `config = configBody` above already carries default_tier + balanced_model
			// + max_tier — the standard-mode "Main chat model" picker binds to them via
			// `mainModelSelection`/`setMainModel`. An unset default_tier resolves to the
			// balanced option (the engine default). Background tasks/subagents still
			// auto-route across bands regardless of this pick.
			// PR-4 routing state: hybrid only when explicitly persisted; seed the
			// per-tier {provider, model} slots from the saved tier_set (else defaults).
			routingMode = configBody.routing_mode === 'hybrid' ? 'hybrid' : 'standard';
			seedTierSlots(configBody.tier_set);
			// Derive the active strategy card: a stored tier_preset wins (returned
			// verbatim by GET); else a persisted hybrid tier_set is a manual "Eigene";
			// else Standard. On a fresh load nothing is dirty.
			strategy = (configBody.tier_preset && PRESET_NAMES.includes(configBody.tier_preset as typeof PRESET_NAMES[number]))
				? (configBody.tier_preset as Strategy)
				: routingMode === 'hybrid' ? 'custom' : 'standard';
			dirty = false;
			if (statusRes.ok) {
				const status = (await statusRes.json()) as { configured?: { api_key?: boolean } };
				apiKeyConfigured = status.configured?.api_key === true;
			} else {
				apiKeyConfigured = null;
			}
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('llm.load_failed'), 'error', 5000);
		}
	}

	/**
	 * Pick the default openai_model_id when the user switches to a new
	 * provider. Prefers the "main" tier (sonnet) so orchestration lands on
	 * the workhorse model. Falls back to the first catalog entry. Returns
	 * `undefined` for providers without an enumerated catalog (custom).
	 */
	function pickDefaultModelIdForEntry(entry: CatalogProvider): string | undefined {
		if (!entry.models || entry.models.length === 0) return undefined;
		const mainTier = entry.models.find((m) => m.tier === 'sonnet');
		if (mainTier) return mainTier.id;
		return entry.models[0]?.id;
	}

	// The ⚡ "expensive" cue ($20+/M out) — threshold owned by the picker helper
	// (isExpensiveModel) so the hybrid editor + the main picker can't drift apart.
	function isExpensive(m: CatalogModel): boolean {
		return isExpensiveModel(m.pricing);
	}

	/**
	 * Default model id for a tier within a provider's catalog: the first model
	 * tagged with that tier, falling back to the first model overall. Used to
	 * seed the hybrid per-tier dropdowns. (Mistral lists two `fast` models —
	 * this picks the first; the user freely re-picks in the dropdown.)
	 */
	function defaultTierModelId(entry: CatalogProvider, tier: ModelTier): string {
		return (entry.models.find((m) => m.tier === tier) ?? entry.models[0])?.id ?? '';
	}

	/** Catalog entry for a UI key ('anthropic' | 'mistral' | …), if present. */
	function catalogEntryByKey(key: string): CatalogProvider | undefined {
		return providers.find((p) => catalogEntryKey(p) === key);
	}

	// Providers selectable per tier in hybrid mode: the catalogued, key-via-vault
	// ones (Anthropic + Mistral). Free-text endpoints (custom / openai-compat) and
	// the retired Vertex tile are out of scope for the per-tier picker for now.
	const hybridProviderOptions = $derived(
		providers.filter((p) => p.models.length > 0 && p.provider !== 'vertex'),
	);

	/** Seed each tier's {provider, model} from a saved tier_set, else defaults. */
	function seedTierSlots(fromSet?: TierSet): void {
		const opts = hybridProviderOptions;
		if (opts.length === 0) return;
		// Default provider for an unset tier: the active tile if it's a valid
		// hybrid option, else the first option (Anthropic).
		const fallbackKey = (activeCatalogKey && opts.some((p) => catalogEntryKey(p) === activeCatalogKey))
			? activeCatalogKey
			: catalogEntryKey(opts[0]!);
		const next: Record<ModelTier, { catalogKey: string; modelId: string }> = {
			fast: { catalogKey: '', modelId: '' },
			balanced: { catalogKey: '', modelId: '' },
			deep: { catalogKey: '', modelId: '' },
		};
		for (const tier of TIER_ORDER) {
			const slot = fromSet?.[tier];
			let key = fallbackKey;
			let modelId = '';
			if (slot) {
				// Map a saved slot back to a tile via provider + base URL; keep it
				// only if it resolves to a valid hybrid option and its model exists.
				const resolved = resolveCatalogKey(slot.provider as LLMProvider, slot.api_base_url);
				const entry = catalogEntryByKey(resolved);
				if (entry && opts.some((o) => catalogEntryKey(o) === resolved)) {
					key = resolved;
					if (entry.models.some((m) => m.id === slot.model_id)) modelId = slot.model_id;
				}
			}
			const entry = catalogEntryByKey(key);
			if (entry && !modelId) modelId = defaultTierModelId(entry, tier);
			next[tier] = { catalogKey: key, modelId };
		}
		tierSlots = next;
	}

	/**
	 * Build the tier_set to persist: per tier {provider, model_id, api_base_url?}.
	 * NO api_key — each provider's key lives in the vault (entered below); the
	 * engine injects it per slot at config-load (never written to config.json).
	 */
	function currentTierSet(): TierSet {
		const set: TierSet = {};
		for (const tier of TIER_ORDER) {
			const { catalogKey, modelId } = tierSlots[tier];
			const entry = catalogEntryByKey(catalogKey);
			if (!entry || !modelId) continue;
			set[tier] = {
				provider: entry.provider,
				model_id: modelId,
				...(entry.base_url_default ? { api_base_url: entry.base_url_default } : {}),
			};
		}
		return set;
	}

	// Pick a "Modell-Strategie" card. Stages locally (rafael's explicit-save model):
	// a disabled preset (CP can't back it) is a no-op. `strategy` drives which
	// controls show (provider picker for Standard, per-tier editor for Eigene, the
	// inline detail for a preset); what persists is decided in runSaveConfig from it.
	//
	// The five cards (order = Standard → cheap → flagship → manual). `key` is the
	// i18n stem (hyphenated ids can't be a translation-key segment). Icons are the
	// monochrome set: ✓ Standard · ⚡ Efficient · ⚖️ Balanced · 💎 Max-Quality ·
	// sliders for the manual Eigene.
	const STRATEGY_CARDS: ReadonlyArray<{ id: Strategy; key: string; icon: IconName; recommended?: boolean }> = [
		{ id: 'standard', key: 'standard', icon: 'check_circle', recommended: true },
		{ id: 'efficient', key: 'efficient', icon: 'bolt' },
		{ id: 'balanced', key: 'balanced', icon: 'scale' },
		{ id: 'max-quality', key: 'max_quality', icon: 'gem' },
		{ id: 'custom', key: 'custom', icon: 'sliders' },
	];
	/** The server preset signal for a card, or undefined for Standard/Custom. */
	function presetInfoFor(id: Strategy): PresetInfo | undefined {
		return id !== 'standard' && id !== 'custom' ? availablePresets[id] : undefined;
	}
	/** A preset card the CP can't back → disabled (Standard/Custom always available). */
	function cardDisabled(id: Strategy): boolean {
		const p = presetInfoFor(id);
		return !!p && !p.available;
	}
	function toggleDetails(id: string): void {
		expandedDetails = { ...expandedDetails, [id]: !expandedDetails[id] };
	}
	// The active preset's resolved per-tier rows (for the inline detail panel).
	const activePresetTiers = $derived(presetInfoFor(strategy)?.tiers ?? []);

	function selectStrategy(next: Strategy): void {
		if (next === strategy) return;
		const preset = next !== 'standard' && next !== 'custom' ? availablePresets[next] : undefined;
		if (preset && !preset.available) return; // disabled card — no-op
		strategy = next;
		// Entering Eigene seeds the per-tier editor from the persisted tier_set (a
		// manual hybrid the user saved before), else provider defaults. It does NOT
		// carry a preset's slots — a just-selected preset persists tier_set:{}, and a
		// Fireworks slot has no per-tier provider tile — so switching a preset→Eigene
		// starts from defaults, not the preset's models.
		if (next === 'custom') seedTierSlots(config.tier_set);
		markDirty();
	}

	function setTierProvider(tier: ModelTier, catalogKey: string): void {
		const entry = catalogEntryByKey(catalogKey);
		const modelId = entry ? defaultTierModelId(entry, tier) : '';
		tierSlots = { ...tierSlots, [tier]: { catalogKey, modelId } };
		markDirty();
	}

	function setTierModel(tier: ModelTier, modelId: string): void {
		tierSlots = { ...tierSlots, [tier]: { ...tierSlots[tier], modelId } };
		markDirty();
	}

	// Distinct provider tiles used across the slots — drives the per-provider key
	// fields in hybrid mode (each provider's key persists to its own vault slot).
	const usedHybridProviders = $derived.by(() => {
		const seen = new Set<string>();
		const out: CatalogProvider[] = [];
		for (const tier of TIER_ORDER) {
			const key = tierSlots[tier].catalogKey;
			if (!key || seen.has(key)) continue;
			const entry = catalogEntryByKey(key);
			if (entry) { seen.add(key); out.push(entry); }
		}
		return out;
	});

	function selectCatalogEntry(entry: CatalogProvider): void {
		if (isTileLocked(entry)) {
			addToast(t('llm.locked_provider'), 'info', 3000);
			return;
		}
		activeProvider = entry.provider;
		activeCatalogKey = catalogEntryKey(entry);
		// Standard-mode tile: picks the single active provider. Hybrid slots are
		// independent (each tier picks its own provider) and seeded on the
		// Standard→Hybrid toggle, so no per-tier reseed is needed here.
		// Fix A (v1.5.2): auto-default the main-tier model for the new
		// provider's catalog so the <select bind:value={openai_model_id}>
		// renders the right option highlighted instead of blank. Pre-fix
		// rafael-prod 2026-05-18: switching to Mistral left openai_model_id
		// empty, the dropdown looked unselected, and "Verbindung testen"
		// failed because no model was wired.
		const defaultForNewProvider = pickDefaultModelIdForEntry(entry);
		// A pinned preset with an EMPTY model catalog (Ollama, Groq, …) has no
		// default to stamp — the model id is free-text. Carrying the previous
		// provider's id across is worse than leaving it blank: `mistral-large-2512`
		// saves cleanly (200), readiness reports green, and every single chat then
		// 404s against Ollama, which has never heard of that model.
		const freeTextModel = entry.models.length === 0;
		if (entry.base_url_default && !entry.requires_base_url) {
			// Pinned preset (e.g. Mistral → api.mistral.ai). Stamp it so
			// save→reload round-trips back to this preset and the user
			// doesn't have to type a URL they didn't choose.
			config = {
				...config,
				api_base_url: entry.base_url_default,
				...(defaultForNewProvider
					? { openai_model_id: defaultForNewProvider }
					: freeTextModel ? { openai_model_id: '' } : {}),
			};
		} else if (entry.requires_base_url
			&& config.api_base_url
			&& providers.some((p) => p.base_url_default === config.api_base_url)) {
			// Switching FROM a pinned preset (Mistral) TO a free-text one
			// (openai-compat). Detect "the URL we have was stamped by a
			// pinned preset" via membership in `base_url_default` across
			// the catalog. Also clear openai_model_id (mistral-large-2512
			// pinned against a free-text endpoint would 404 every probe).
			config = { ...config, api_base_url: '', openai_model_id: '' };
		} else if (!entry.requires_base_url && !entry.base_url_default) {
			// P3-FOLLOWUP-HOTFIX-2: switching to a provider that uses neither
			// a free-text nor a pinned base_url (Anthropic). Clear any stale
			// value left over from a previous Mistral selection — otherwise
			// the Anthropic adapter gets initialised with the Mistral host
			// and every chat 404s. Same for `openai_model_id`, which is
			// only valid when provider ∈ {openai, custom}.
			config = { ...config, api_base_url: '', openai_model_id: '' };
		}
		testResult = null;

		// Auto-save tile-click for curated providers (no free-text required).
		// Without this, the user clicked the tile, navigated to chat, and the
		// next message still ran on the previous provider — silent UX miss
		// caught by HN-launch staging probe 2026-05-23. Custom-endpoint tiles
		// still defer to the explicit Save button (api_base_url + model id
		// are required cross-field, server returns 400 if absent).
		//
		// A pinned preset with a free-text model is the SAME case, even though its
		// URL is pinned: the server rejects provider:'openai' without an
		// openai_model_id. Auto-saving it fires a 400 the instant the user clicks
		// the tile — before they have had any chance to type the model. So hold the
		// save until the id is there, exactly as the free-text tiles do.
		// Explicit-save model (rafael W4): a tile click now STAGES the change; the
		// "Ungespeicherte Änderungen" bar + Save button commit it — no surprise write
		// on every click. Replaces the former tile-click auto-save (fear of silently
		// navigating away on the old provider, HN-launch staging 2026-05-23); the
		// unsaved bar makes the pending change visible instead.
		markDirty();
	}

	// Custom-Endpoint Confirm-Banner (PRD Security Model): the SSRF guard
	// blocks private-IP exfiltration, but a public attacker-controlled URL
	// would still receive the user's API key. Gate the first probe per
	// distinct base_url behind an explicit user confirm. sessionStorage so
	// power-users don't re-confirm the same URL on every test in a session.
	let pendingTestUrl = $state<string | null>(null);

	function shouldConfirmCustomUrl(provider: LLMProvider, url: string | undefined): boolean {
		if (provider !== 'custom' && provider !== 'openai') return false;
		if (!url || url.trim().length === 0) return false;
		// Skip the SSRF disclosure for vetted sub-processor hosts (api.mistral.ai,
		// api.anthropic.com). Without this, Mistral users hitting "Test connection"
		// on a well-known EU-sovereign endpoint see a scary "could capture your
		// key" warning — the modal is intended for arbitrary attacker-controlled
		// URLs, not for the curated provider presets the UI itself surfaces.
		if (isAllowlistedEndpoint(url)) return false;
		if (typeof sessionStorage === 'undefined') return false;
		const key = `llm_custom_confirmed:${url}`;
		return !sessionStorage.getItem(key);
	}

	function markCustomUrlConfirmed(url: string): void {
		if (typeof sessionStorage === 'undefined') return;
		sessionStorage.setItem(`llm_custom_confirmed:${url}`, '1');
	}

	async function testConnection(): Promise<void> {
		if (!activeProvider) return;
		if (shouldConfirmCustomUrl(activeProvider, config.api_base_url)) {
			pendingTestUrl = config.api_base_url ?? '';
			return; // wait for modal-confirm
		}
		await runProbe();
	}

	async function runProbe(): Promise<void> {
		if (!activeProvider) return;
		testing = true;
		testResult = null;
		try {
			const slot = slotForEntry(activeProviderEntry);
			const apiKey = slot ? (keys[slot] ?? '') : '';
			const res = await fetch(`${getApiBase()}/llm/test`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					provider: activeProvider,
					api_key: apiKey,
					base_url: config.api_base_url,
					model: activeProviderEntry?.models[0]?.id,
				}),
			});
			const data = (await res.json()) as { ok?: boolean; latency_ms?: number; error?: string };
			if (res.ok && data.ok) {
				testResult = { ok: true, latency_ms: data.latency_ms ?? 0 };
			} else {
				testResult = { ok: false, message: data.error ?? `HTTP ${res.status}` };
			}
		} catch (e) {
			testResult = { ok: false, message: e instanceof Error ? e.message : t('llm.test_failed') };
		} finally {
			testing = false;
		}
	}

	// Wave 5d — BYOK custom-endpoint disclosure gate.
	// State for the disclosure modal: holds the URL pending acceptance + the
	// "I understand and accept" checkbox state. Gating predicate runs before
	// every saveConfig call when api_base_url points outside lynox's vetted
	// sub-processor allowlist. Acceptance is captured per-URL in sessionStorage
	// so the modal doesn't re-fire on every tweak to the same custom endpoint
	// within a session (consistent with the existing key-exfil confirm flow).
	let pendingDisclosureUrl = $state<string | null>(null);
	let disclosureAccepted = $state(false);

	function shouldShowDisclosure(provider: typeof activeProvider, url: string | undefined): boolean {
		// CP-managed tenants (managed / managed_pro / eu) can't reach non-
		// allowlisted endpoints via the UI (custom_provider_endpoints lock +
		// curated tile list), so we never gate them. Self-host + Hosted-BYOK
		// starter (BYOK) go through the gate per the comment intent.
		// Pre-fix this used isManaged() which incorrectly returned true for
		// `starter` BYOK too, dropping the gate where it was needed.
		if (cpSuppliesLLMKeyForInstance()) return false;
		if (provider !== 'custom' && provider !== 'openai') return false;
		if (!url || url.trim().length === 0) return false;
		if (isAllowlistedEndpoint(url)) return false;
		// Acceptance is now SERVER-persisted (config.accepted_custom_endpoints),
		// so it survives reload / a new device — the old sessionStorage flag was
		// per-tab and lost on refresh. Re-prompt only if THIS host has no
		// recorded acceptance.
		return !isHostAlreadyAccepted(url);
	}

	/** True if the URL's host already has a server-persisted disclosure acceptance. */
	function isHostAlreadyAccepted(url: string): boolean {
		const host = disclosureHostname(url);
		return (config.accepted_custom_endpoints ?? []).some((e) => e.host === host);
	}

	// Discard staged changes (explicit-save model): drop the unsaved key inputs and
	// re-fetch the server truth, which re-derives strategy/routing/tierSlots + clears
	// `dirty`. Cheaper than tracking a per-field snapshot for a settings page.
	function discardChanges(): void {
		keys = {};
		void load();
	}

	async function saveConfig(): Promise<void> {
		if (!activeProvider || !loaded) return;
		if (shouldShowDisclosure(activeProvider, config.api_base_url)) {
			pendingDisclosureUrl = config.api_base_url ?? '';
			disclosureAccepted = false;
			return; // wait for the modal-accept path to call runSaveConfig
		}
		await runSaveConfig();
	}

	async function runSaveConfig(): Promise<void> {
		if (!activeProvider || !loaded) return;
		saving = true;
		try {
			// 1. Save keys to vault first (only if non-empty — empty means keep existing).
			// Throw on 4xx/5xx so a silently-rejected vault write doesn't toast "saved"
			// after the config PUT — user thought their key landed but the vault refused it.
			for (const [slot, value] of Object.entries(keys)) {
				if (value.length > 0) {
					const secretRes = await fetch(`${getApiBase()}/secrets/${slot}`, {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ value }),
					});
					if (!secretRes.ok) throw new Error(`Vault rejected ${slot}: HTTP ${secretRes.status}`);
				}
			}
			// 2. Save config. Provider-binding logic extracted to a pure helper
			// so it can be unit-tested without a Svelte runtime — see
			// `utils/llm-config-update.ts` for the contract + regression-pin
			// tests for the F1 stale-fields bug (2026-05-17 staging QA).
			const update: UserConfig = buildLLMConfigUpdate({
				providerLocked,
				activeProvider,
				activeProviderEntry: activeProviderEntry ?? null,
				config: {
					api_base_url: config.api_base_url,
					gcp_project_id: config.gcp_project_id,
					gcp_region: config.gcp_region,
					default_tier: config.default_tier,
					balanced_model: config.balanced_model,
					openai_model_id: config.openai_model_id,
					custom_endpoints: config.custom_endpoints,
				},
			});
			// Advanced / Memory / Context-Window have moved to /settings/llm/advanced
			// and /settings/llm/memory (PRD-IA-V2 P3-PR-C) — their save paths live on
			// those views and PUT the same /api/config endpoint.
			//
			// confirm_custom_endpoint:true tells the server-side liability gate to
			// accept (and server-persist) a non-allowlisted endpoint. We only reach
			// runSaveConfig after shouldShowDisclosure passed — i.e. the host is
			// allowlisted, already accepted, or just accepted in the modal — so it
			// is always correct to assert acceptance here for a non-allowlisted URL.
			const url = config.api_base_url;
			const needsConfirm =
				(activeProvider === 'custom' || activeProvider === 'openai') &&
				typeof url === 'string' && url.trim().length > 0 &&
				!isAllowlistedEndpoint(url);
			// model-presets W4 — persist the chosen "Modell-Strategie" card. The
			// strategy→body mapping (preset-by-name / clear-to-standard / custom hybrid,
			// including the load-bearing tier_preset:null CLEAR) lives in the unit-tested
			// `buildRoutingUpdate` helper. Managed is allow-listed for these fields
			// (MANAGED_USER_WRITABLE_CONFIG) and sanitised server-side at load; the UI
			// never sends a key in a slot — keys go to the vault.
			const isPreset = strategy !== 'standard' && strategy !== 'custom';
			const routingUpdate = buildRoutingUpdate(strategy, {
				existingTierSet: config.tier_set,
				customTierSet: strategy === 'custom' ? currentTierSet() : {},
			});
			const body = needsConfirm
				? { ...update, ...routingUpdate, confirm_custom_endpoint: true }
				: { ...update, ...routingUpdate };
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				// Surface the server's named reason (e.g. "provider:'openai' requires
				// openai_model_id") instead of a bare "HTTP 400" — otherwise a save
				// that fails validation looks like a silent no-op (H-007: OpenAI-compat
				// save with no model-id swallowed the 400). Falls back to the status.
				let reason = `HTTP ${res.status}`;
				try {
					const errBody = (await res.json()) as { error?: string; disclosure?: string };
					if (typeof errBody.error === 'string' && errBody.error) reason = errBody.error;
				} catch { /* non-JSON body — keep the status string */ }
				throw new Error(reason);
			}
			// The routing/tier config may have changed → drop the shared tier-config
			// cache so the composer + header model pickers re-fetch the new per-tier
			// model labels immediately (else they'd show the pre-save model, e.g. the
			// "Mistral Large 3" stale-label after switching balanced to Ministral 14B).
			clearTierConfigCache();
			// Mirror the server-recorded acceptance locally so the modal doesn't
			// re-fire for this host before the next config reload.
			if (needsConfirm && typeof url === 'string') {
				const host = disclosureHostname(url);
				const prior = config.accepted_custom_endpoints ?? [];
				if (!prior.some((e) => e.host === host)) {
					config.accepted_custom_endpoints = [...prior, { host, accepted_at: new Date().toISOString() }];
				}
			}
			// Persist committed → clear the unsaved-changes state (explicit-save model)
			// and mirror the chosen strategy into local config so a later re-derive
			// (without a full reload) stays consistent with what was written.
			dirty = false;
			config.tier_preset = isPreset ? strategy : undefined;
			addToast(t('llm.saved'), 'success', 3000);
			// Tell the StatusBar (and any other live provider indicator) to refresh
			// NOW instead of waiting up to 30s for its next poll — otherwise the
			// footer keeps showing the previous provider after a switch and the user
			// thinks the save didn't take (found during demo-walk hardening, Anthropic↔Mistral).
			if (typeof window !== 'undefined') {
				window.dispatchEvent(new CustomEvent('lynox:provider-changed'));
			}
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('llm.save_failed'), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	$effect(() => { void load(); });
	// v1.5.2: hydrate the managed-tier flag so the API-key + Test-connection
	// blocks can be hidden entirely on managed (where the CP supplies the
	// LLM key — the user has no path to provide their own).
	$effect(() => { void loadManagedStatus(); });

	const activeProviderEntry = $derived(
		providers.find((p) => catalogEntryKey(p) === activeCatalogKey)
		?? providers.find((p) => p.provider === activeProvider),
	);
	// model-presets W4: the "Modell-Strategie" cards replace the Standard/Hybrid
	// toggle. `presetSelected` = a fixed preset card is active (its tiers show
	// read-only ON the card, so the provider picker + per-tier editor both hide).
	// `hybridActive` = the manual "Eigene" card → the per-tier editor shows. The
	// provider picker + main-model picker show ONLY for the Standard card.
	const presetSelected = $derived(strategy !== 'standard' && strategy !== 'custom');
	// Hybrid mode is active (managed OR self-host): the per-tier editor replaces
	// the single-provider flow (tiles + one key + residency/test). The per-tier
	// PROVIDER choices are the catalogued allowlist (Anthropic + Mistral), which
	// is exactly the managed curated set — so managed hybrid reuses the same UI;
	// only the per-provider key fields are self-host-only (managed: CP supplies,
	// server-side `applyManagedTierSetConstraints` sources the keys at load).
	const hybridActive = $derived(strategy === 'custom');
	const providerLocked = $derived(!!locks.provider);
	const customEndpointsLocked = $derived(!!locks.custom_provider_endpoints);
	// `LYNOX_LLM_PROVIDER` is set → any provider switch is rejected (env wins on
	// reload + backend 403s the save). Drives the read-only tile state below.
	const providerEnvPinned = $derived(!!config.env_overrides?.provider);

	// On CP-supplied managed tiers (managed / managed_pro) the provider is capped to
	// the curated set {Anthropic, Mistral}: the backend `enforceManagedProviderConstraints`
	// rejects anything else on save. Every BYOK/self-host preset carries a
	// `base_url_default` (so `requires_base_url` is false), which means the
	// `customEndpointsLocked` tile-lock never covers them — they showed as fully
	// selectable and a save just 403'd. Filter them OUT of the tile list entirely so a
	// managed customer is never offered a provider whose save can't land. Hosted-BYOK
	// (customer's own key, `cpSuppliesLLMKeyForInstance() === false`) keeps the full list.
	const isManagedCuratedProvider = (p: CatalogProvider): boolean =>
		p.provider === 'anthropic' || (p.provider === 'openai' && p.preset_id === 'mistral');
	const providersForDisplay = $derived(
		providers.filter((p) => {
			if (p.provider === 'vertex' && activeProvider !== 'vertex') return false;
			if (cpSuppliesLLMKeyForInstance() && !isManagedCuratedProvider(p)) return false;
			return true;
		}),
	);

	// ── Standard-mode "Main chat model" picker (PR model-select · arch-v2 Simple
	// view). The main chat runs on `default_tier` (+ the Anthropic `balanced_model`
	// variant); this select lets the user set it directly instead of hiding the
	// knob. Options come verbatim from the server-computed `main_chat_models`, so
	// the UI never mirrors the tier→model map (drift-free; Grok/Gemini providers
	// get options for free). Background tasks + subagents keep auto-routing across
	// bands regardless — this only pins the main-chat starting model. The option-
	// derivation + selection-matching logic is unit-tested in ../utils/llm-main-model.js. ──
	const mainModelOptions = $derived.by<MainModelOption[]>(
		() => buildMainModelOptions(activeProviderEntry, config.max_tier),
	);
	// Tier-qualified key (`${tier}:${id}`), not a bare id: a provider whose
	// balanced and deep bands resolve to the SAME model (Mistral Medium 3.5) emits
	// two options sharing an id, so a bare-id `<select value>`/each-key collides
	// (Svelte `each_key_duplicate` crash; the deep option unselectable). The
	// composite keeps each option a distinct, selectable identity.
	const mainModelSelection = $derived.by<string>(
		() => selectMainModelKey(mainModelOptions, config.default_tier, config.balanced_model),
	);

	function setMainModel(key: string): void {
		// Resolve BY TIER-QUALIFIED KEY — a bare-id `find` would collapse a deep
		// pick onto the first (balanced) option when they share a model id.
		const opt = findMainModelOptionByKey(mainModelOptions, key);
		if (!opt || opt.overCeiling) return;
		config.default_tier = opt.tier;
		// Only the Anthropic balanced band carries a variant. Set it when the
		// picked option specifies one; leave the stored preference otherwise (so
		// switching to Opus and back to a balanced pick remembers Sonnet 4.6/5).
		if (opt.balanced_model) config.balanced_model = opt.balanced_model;
		markDirty();
	}

	// Per-tile predicate — extracted to ../utils/llm-tile-lock.js so the
	// env-pin / lock matrix is unit-tested. On Managed only free-text endpoints
	// are off-limits; an operator hard-lock pins everything but the active tile;
	// an env-pin disables every tile (staging-walk finding 2026-05-30).
	function isTileLocked(entry: CatalogProvider): boolean {
		return isProviderTileLocked({
			providerEnvPinned,
			providerLocked,
			customEndpointsLocked,
			isActive: catalogEntryKey(entry) === activeCatalogKey,
			requiresBaseUrl: !!entry.requires_base_url,
		});
	}

	// Empty-state CTA (PRD acceptance: fresh ~/.lynox/config.json → SetupBanner
	// → click → lands on /settings/llm empty-state). Triggers when neither a
	// provider was persisted to config.json nor an LLM key exists in the vault.
	// Conservative: hide the CTA when /secrets/status is unreachable (apiKeyConfigured===null).
	const showEmptyState = $derived(
		loaded && !providerLocked && !providerExplicit && apiKeyConfigured === false,
	);

	// Data-driven sub-route nav (PRD-IA-V2 P3-PR-C). Single source of truth for
	// the LLM-page sub-nav so adding a 4th entry is a one-line array append.
	// Future: openai-native sub-route slots in here, see PRD-OPENAI-NATIVE.md Phase 4.
	interface SubRoute {
		href: string;
		titleKey: string;
		descKey: string;
	}
	const llmSubRoutes: ReadonlyArray<SubRoute> = [
		// IA reorg (D2): API keys for 3rd-party tools (DataForSEO, etc.) live at
		// /app/settings/llm/keys (low-frequency config — Settings is the home).
		// (Tavily was retired 2026-05-24; SearXNG uses a URL, not a key.)
		// Settings v3 PR 4.6 (2026-05-19): /llm/advanced removed from this nav
		// — Advanced settings now render inline below as an expandable section.
		// The /advanced route still exists for back-compat with deep links.
		{ href: '/app/settings/llm/memory',   titleKey: 'llm.subnav.memory.title',   descKey: 'llm.subnav.memory.desc' },
	];
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('llm.back_to_settings')}</a>
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('llm.title')}</h1>
		<p class="text-sm text-text-muted">{t('llm.subtitle')}</p>
	</header>

	{#if config.env_overrides?.provider}
		<!-- Self-host docs recommend setting LYNOX_LLM_PROVIDER in .env, which
		     overrides config.json on every engine reload. Without this banner,
		     clicking a different provider tile and Save succeeds silently
		     against disk but the env wins on the next reload and the UI choice
		     vanishes — the silent-failure rafael hit during the #42 verify. -->
		<div role="status" class="border border-warning bg-warning/10 rounded p-3 text-sm">
			<p class="font-medium">{t('llm.env_override_title')}</p>
			<p class="text-text-muted mt-1">{config.managed ? t('llm.env_override_body_managed') : t('llm.env_override_body_selfhost')}</p>
			{#if !config.managed}
				<p class="text-xs text-text-muted mt-2 font-mono">LYNOX_LLM_PROVIDER</p>
			{/if}
		</div>
	{/if}

	{#if providerLocked}
		<div class="border border-warning bg-warning/10 rounded p-3 text-sm">
			<p>{t('llm.locked_notice')}</p>
			{#if locks.provider?.upgrade_cta}
				<a href={locks.provider.upgrade_cta.href} class="text-accent-text underline mt-1 inline-block">{locks.provider.upgrade_cta.label}</a>
			{/if}
		</div>
	{:else if customEndpointsLocked}
		<!-- P3-FOLLOWUP-HOTFIX: narrower notice for Managed — curated providers
		     stay switchable, only free-text endpoints are off-limits. -->
		<div class="border border-warning/50 bg-warning/5 rounded p-3 text-sm">
			<p>{t('llm.custom_endpoints_locked_notice')}</p>
		</div>
	{/if}

	{#if showEmptyState}
		<!--
			Empty-state CTA — PRD-IA-V2 P1-PR-A1 acceptance: SetupBanner cold-start
			path lands on /settings/llm and shows a primary "Provider wählen + Key
			eintragen" CTA. Provider picker below is always present once activeProvider
			is set; this banner just nudges first-paint users into the picker.
		-->
		<div role="status" class="border border-accent/40 bg-accent/5 rounded p-4 text-sm space-y-2">
			<p class="font-medium">{t('llm.empty_state_title')}</p>
			<p class="text-text-muted">{t('llm.empty_state_body')}</p>
			<p class="text-xs text-text-muted">{t('llm.empty_state_hint')}</p>
		</div>
	{/if}

	<!-- Modell-Strategie (model-presets W4) — the PRIMARY axis. Replaces the
	     Standard/Hybrid toggle with five cards: Standard (one provider, lynox routes
	     per turn) · ⚡ Efficient · ⚖️ Balanced · 💎 Max-Quality (named hybrid presets)
	     · Eigene (manual hybrid). A preset the CP can't back renders disabled with a
	     lock reason (locks.tier_preset) — never a silent downgrade. The controls
	     below adapt: Standard → provider picker + main-model; a preset → the inline
	     tier detail below; Eigene → the per-tier editor. NO capability gating for the
	     enabled set (D8 2026-06-17). -->
	{#if loaded}
		<section aria-labelledby="llm-strategy-heading" class="space-y-3">
			<div class="space-y-0.5">
				<h2 id="llm-strategy-heading" class="text-lg font-medium">{t('llm.preset.heading')}</h2>
				<p class="text-xs text-text-muted">{t('llm.preset.subheading')}</p>
			</div>
			<div role="radiogroup" aria-label={t('llm.preset.heading')}
				class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
				{#each STRATEGY_CARDS as card (card.id)}
					{@const disabled = cardDisabled(card.id)}
					{@const active = strategy === card.id}
					<button type="button" role="radio" aria-checked={active} disabled={disabled || providerLocked}
						onclick={() => selectStrategy(card.id)}
						class="text-left p-3 rounded-[var(--radius-md)] border-2 transition-colors flex flex-col gap-1.5 h-full
							{active ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'}
							disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border">
						<div class="flex items-center gap-x-2 gap-y-1 flex-wrap">
							<Icon name={card.icon} size="sm" class={active ? 'text-accent' : 'text-text-muted'} />
							<span class="font-medium text-sm">{t(`llm.preset.${card.key}`)}</span>
							{#if card.recommended}
								<span class="text-[10px] font-normal uppercase tracking-wide px-1 py-px rounded border border-accent/40 text-accent whitespace-nowrap">
									{t('llm.preset.recommended')}
								</span>
							{/if}
						</div>
						<p class="text-xs text-text-muted leading-snug">{t(`llm.preset.${card.key}_desc`)}</p>
						{#if disabled}
							<p class="text-[11px] text-warning mt-auto pt-1">{t('llm.preset.unavailable')}</p>
						{/if}
					</button>
				{/each}
			</div>

			<!-- Contact CTA for a preset the plan can't back — the card button is
			     disabled (no interactive child allowed), so the action lives here.
			     Server-driven: shown only when the CP sends locks.tier_preset. -->
			{#if locks.tier_preset?.contact_cta}
				<p class="text-xs text-text-muted">
					{t('llm.preset.unavailable')}
					<a href={locks.tier_preset.contact_cta.href} class="text-accent hover:underline ml-1">
						{t('llm.preset.unavailable_cta')}
					</a>
				</p>
			{/if}

			<!-- Inline tier detail for the active PRESET (rafael: "kompakt inline +
			     Detail auf Klick"). Compact per-tier model + provenance chip; the
			     "Details" toggle reveals the full three-axis, R2-gated disclosure. -->
			{#if presetSelected && activePresetTiers.length > 0}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-3 space-y-2">
					{#each activePresetTiers as tier (tier.tier)}
						<div class="flex items-center gap-2 text-sm flex-wrap">
							<span class="text-text-muted w-24 shrink-0">{t(`llm.tier.${tier.tier}`)}</span>
							<span class="font-medium">{tier.label}</span>
							<!-- Compact chips: the model's WEIGHTS origin (provenance) + where
							     it's PROCESSED (residency). Show residency only when it differs
							     from provenance — else an EU model on an EU host reads as a
							     redundant "EU EU"; the meaningful case is divergence (GLM: China
							     weights on a US host → "China" + "US"). Full detail in the expand. -->
							{#if tier.provenance}
								<span class="text-[10px] uppercase tracking-wide px-1.5 py-px rounded border border-border text-text-muted">
									{t(`llm.preset.provenance.${tier.provenance}`)}
								</span>
							{/if}
							{#if tier.residency && tier.residency !== tier.provenance}
								<span class="text-[10px] px-1.5 py-px rounded bg-bg-muted text-text-subtle">{tier.residency}</span>
							{/if}
							<!-- Cost feel (rafael): input/output $/M, right-aligned. Same
							     "$X/M in · $Y/M out" format as the standard main-model picker
							     (in/out is universal token-pricing notation — hardcoded there too). -->
							{#if tier.pricing}
								<span class="text-[11px] text-text-subtle ml-auto tabular-nums whitespace-nowrap">
									${tier.pricing.input}/M in · ${tier.pricing.output}/M out
								</span>
							{/if}
						</div>
						{#if expandedDetails[strategy]}
							<dl class="ml-24 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] text-text-muted">
								{#if tier.residency}
									<dt>{t('llm.preset.disclosure.residency')}</dt><dd>{tier.residency}</dd>
								{/if}
								{#if tier.transferBasis}
									<dt>{t('llm.preset.disclosure.transfer')}</dt><dd>{tier.transferBasis}</dd>
								{/if}
								{#if tier.provenance}
									<dt>{t('llm.preset.disclosure.provenance')}</dt><dd>{t(`llm.preset.provenance.${tier.provenance}`)}</dd>
								{/if}
								{#if tier.posture}
									<dt>{t('llm.preset.disclosure.posture')}</dt><dd>{tier.posture}</dd>
								{/if}
							</dl>
						{/if}
					{/each}
					<div class="flex items-center justify-between pt-1">
						<button type="button" onclick={() => toggleDetails(strategy)}
							class="text-xs text-accent hover:underline flex items-center gap-1">
							<Icon name={expandedDetails[strategy] ? 'chevron_up' : 'chevron_down'} size="xs" />
							{expandedDetails[strategy] ? t('llm.preset.hide_details') : t('llm.preset.details')}
						</button>
						<span class="text-[11px] text-text-subtle">{t('llm.preset.applies_hint')}</span>
					</div>
				</div>
			{/if}
		</section>
	{/if}

	<!-- Provider picker — Anthropic / Mistral / Custom. P3-FOLLOWUP-HOTFIX:
	     moved to the top of the page so the user sees the selection control
	     before the sub-route nav. Vertex is wired in the engine for legacy
	     `provider: 'vertex'` config.json setups (see core CLAUDE.md) but no
	     longer offered in-product per project_eu_providers_strategy — filter
	     it out of the tile list. Shown ONLY for the Standard strategy: a preset
	     fixes its own per-tier providers, and Eigene picks a provider per tier. -->
	{#if strategy === 'standard'}
	<section aria-labelledby="llm-provider-heading">
		<h2 id="llm-provider-heading" class="text-lg font-medium mb-3">{t('llm.provider_heading')}</h2>
		<div class="grid gap-2 sm:grid-cols-2">
			{#each providersForDisplay as p (catalogEntryKey(p))}
				<button type="button" onclick={() => selectCatalogEntry(p)} disabled={isTileLocked(p)}
					class="text-left p-3 rounded border-2 transition-colors {catalogEntryKey(p) === activeCatalogKey ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'} disabled:opacity-50 disabled:cursor-not-allowed">
					<div class="font-medium text-sm flex items-center gap-1.5">
						<span>{p.display_name}</span>
						<!-- The caveat used to live inside display_name ("… (experimental)").
						     It is a structured field now, so render it explicitly — lynox is an
						     agent, and "tool-calling not verified here" is a real warning, not a
						     footnote. -->
						{#if p.verification === 'experimental'}
							<span class="text-[10px] font-normal uppercase tracking-wide px-1 py-px rounded border border-border text-text-muted">
								{t('llm.experimental')}
							</span>
						{/if}
					</div>
					<div class="text-xs text-text-muted mt-0.5">{p.default_residency}</div>
				</button>
			{/each}
		</div>
	</section>
	{/if}

	<!--
		LLM sub-route nav (PRD-IA-V2 P3-PR-C). Data-driven so the OpenAI-native
		Phase 4 sub-route slots in as a single array append on `llmSubRoutes`
		without touching the render-tree. Generic third-party API keys live
		under `/keys`; Advanced + Memory got their own sub-pages with this PR.
	-->
	<nav aria-labelledby="llm-subnav-heading" class="space-y-2">
		<h2 id="llm-subnav-heading" class="sr-only">{t('llm.subnav.heading')}</h2>
		{#each llmSubRoutes as route (route.href)}
			<a href={route.href}
				class="block rounded border border-border bg-bg-subtle p-3 hover:border-border-hover transition-colors">
				<div class="text-sm font-medium">{t(route.titleKey)}</div>
				<div class="text-xs text-text-muted mt-0.5">{t(route.descKey)}</div>
			</a>
		{/each}
	</nav>

	{#if activeProviderEntry}
		<!-- Per-provider config form — Standard (single provider: key/base/model/test)
		     or Eigene (per-tier editor). Hidden for a fixed preset: its tiers show in
		     the inline detail panel above and nothing here is editable; the Save row +
		     Advanced below stay visible so a preset choice can still be committed. -->
		{#if !presetSelected}
		<section aria-labelledby="llm-config-heading" class="border-t border-border pt-6 space-y-4">
			<h2 id="llm-config-heading" class="text-lg font-medium">{hybridActive ? t('llm.routing.per_tier_heading') : activeProviderEntry.display_name}</h2>
			{#if !hybridActive && activeProviderEntry.notes}
				<p class="text-xs text-text-muted">{activeProviderEntry.notes}</p>
			{/if}

			{#if slotForEntry(activeProviderEntry) && !cpSuppliesLLMKeyForInstance() && !hybridActive}
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('llm.api_key')}</span>
					<input type="password" autocomplete="off" disabled={!loaded || providerLocked}
						placeholder={t('llm.api_key_placeholder')}
						bind:value={keys[slotForEntry(activeProviderEntry)]} oninput={markDirty}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
					<span class="text-xs text-text-muted">{t('llm.api_key_hint')}</span>
				</label>
			{:else if cpSuppliesLLMKeyForInstance() && !hybridActive}
				<!-- v1.5.2: on managed tiers, the CP supplies the LLM key — the
				     input would be misleading-disabled. Replace with a short
				     note so the user knows why the field is missing. (Hidden in
				     managed Hybrid — the per-tier editor covers it.) -->
				<p class="text-xs text-text-muted rounded border border-border/50 bg-bg-subtle px-3 py-2">
					{t('llm.api_key_managed_note')}
				</p>
			{/if}

			{#if activeProviderEntry.requires_base_url && !hybridActive}
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('llm.base_url')}</span>
					<input type="url" disabled={!loaded || providerLocked}
						placeholder="https://api.mistral.ai/v1"
						bind:value={config.api_base_url} oninput={markDirty}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
				</label>

				{#if activeProvider === 'custom'}
					<!-- Saved custom endpoints (LiteLLM-friendly bookmarks).
					     Pure UI sugar — engine still reads api_base_url. -->
					<div class="space-y-2 pl-3 border-l-2 border-border">
						<p class="text-xs font-medium text-text-muted">{t('llm.endpoints_heading')}</p>
						{#if (config.custom_endpoints ?? []).length === 0}
							<p class="text-xs italic text-text-muted">{t('llm.endpoints_empty')}</p>
						{:else}
							<ul class="space-y-1">
								{#each config.custom_endpoints ?? [] as ep (ep.id)}
									{@const isActive = ep.base_url === config.api_base_url}
									<li class="flex items-center gap-2 text-xs px-1 py-0.5 rounded {isActive ? 'bg-accent/10' : ''}">
										<span class="font-mono">{ep.name}</span>
										{#if isActive}<span class="text-[10px] uppercase tracking-wider text-accent-text">{t('llm.endpoints_active')}</span>{/if}
										<span class="font-mono text-text-muted truncate flex-1">{ep.base_url}</span>
										<button type="button" class="text-accent-text underline disabled:opacity-50 disabled:no-underline"
											disabled={!loaded || providerLocked || isActive}
											onclick={() => { config.api_base_url = ep.base_url; }}>{t('llm.endpoints_use')}</button>
										<button type="button" class="text-danger underline" disabled={!loaded || providerLocked}
											onclick={() => { config.custom_endpoints = (config.custom_endpoints ?? []).filter((e) => e.id !== ep.id); }}>✕</button>
									</li>
								{/each}
							</ul>
						{/if}
						<button type="button" class="text-xs text-accent-text underline" disabled={!loaded || providerLocked || !config.api_base_url}
							onclick={() => {
								const url = config.api_base_url ?? '';
								if (!url) return;
								const raw = (typeof prompt === 'function' ? prompt(t('llm.endpoints_save_prompt'), '') : null) ?? '';
								// S-IV-1: cap user-supplied bookmark name; raw prompt() value would otherwise round-trip
								// to the server unbounded. 80 chars matches the visible row width and config-schema limit.
								const name = raw.trim().slice(0, 80);
								if (!name) return;
								const id = crypto.randomUUID();
								config.custom_endpoints = [...(config.custom_endpoints ?? []), { id, name, base_url: url }];
							}}>{t('llm.endpoints_save_current')}</button>
					</div>
				{/if}
			{/if}

			{#if activeProviderEntry.requires_region && !hybridActive}
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="block">
						<span class="block text-sm font-medium mb-1">{t('llm.gcp_project')}</span>
						<input type="text" disabled={!loaded || providerLocked}
							bind:value={config.gcp_project_id}
							class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
					</label>
					<label class="block">
						<span class="block text-sm font-medium mb-1">{t('llm.gcp_region')}</span>
						<input type="text" placeholder="europe-west4" disabled={!loaded || providerLocked}
							bind:value={config.gcp_region}
							class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
					</label>
				</div>
			{/if}

			{#if hybridActive}
				<!-- Hybrid (PR-4): each tier picks its OWN provider + model. The
				     Standard/Hybrid decision lives at the TOP of the page (it drives
				     this section). Provider choices = the catalogued, key-via-vault
				     ones (Anthropic + Mistral). NO capability gating (D8 2026-06-17):
				     every model is selectable (incl. Opus) — the included budget +
				     per-model cost (⚡ = expensive) control spend. -->
				<div class="space-y-3">
					{#each TIER_ORDER as tier (tier)}
						{@const entry = catalogEntryByKey(tierSlots[tier].catalogKey)}
						<div class="space-y-1 sm:grid sm:grid-cols-[8rem_1fr] sm:gap-3 sm:space-y-0 sm:items-start">
							<div class="sm:pt-1">
								<div class="text-sm font-medium">{t(`llm.tier.${tier}`)}</div>
								<div class="text-xs text-text-muted">{t(`llm.tier.${tier}_desc`)}</div>
							</div>
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
								<select disabled={!loaded || providerLocked} value={tierSlots[tier].catalogKey}
									onchange={(e) => setTierProvider(tier, e.currentTarget.value)}
									aria-label={t('llm.provider_heading')}
									class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
									{#each hybridProviderOptions as p (catalogEntryKey(p))}
										<option value={catalogEntryKey(p)}>{p.display_name}</option>
									{/each}
								</select>
								<select disabled={!loaded || providerLocked || !entry} value={tierSlots[tier].modelId}
									onchange={(e) => setTierModel(tier, e.currentTarget.value)}
									aria-label={t('llm.model')}
									class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
									{#each entry?.models ?? [] as m (m.id)}
										<option value={m.id}>{m.label} — ${m.pricing?.input ?? '?'}/M in · ${m.pricing?.output ?? '?'}/M out{isExpensive(m) ? ' ⚡' : ''}</option>
									{/each}
								</select>
							</div>
						</div>
					{/each}
					<p class="text-xs text-text-muted">{t('llm.routing.budget_hint')}</p>
				</div>

				<!-- Per-provider API keys (self-host / BYOK) — one field per DISTINCT
				     provider used across the tiers. Keys persist to the vault under
				     their canonical slot (ANTHROPIC_API_KEY / MISTRAL_API_KEY), NEVER
				     into the tier_set in config.json; the engine injects each slot's
				     key at config-load. On managed the CP supplies the keys, so a
				     short note replaces the fields. -->
				{#if !cpSuppliesLLMKeyForInstance()}
					{#if usedHybridProviders.length > 0}
						<div class="space-y-2 border-t border-border/50 pt-4">
							<span class="block text-sm font-medium">{t('llm.hybrid_keys_heading')}</span>
							{#each usedHybridProviders as p (catalogEntryKey(p))}
								{#if slotForEntry(p)}
									<label class="block">
										<span class="block text-xs text-text-muted mb-1">{p.display_name}</span>
										<input type="password" autocomplete="off" disabled={!loaded || providerLocked}
											placeholder={t('llm.api_key_placeholder')}
											bind:value={keys[slotForEntry(p)]} oninput={markDirty}
											class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
									</label>
								{/if}
							{/each}
							<span class="text-xs text-text-muted">{t('llm.api_key_hint')}</span>
						</div>
					{/if}
				{:else}
					<p class="text-xs text-text-muted rounded border border-border/50 bg-bg-subtle px-3 py-2">
						{t('llm.api_key_managed_note')}
					</p>
				{/if}
			{:else if mainModelOptions.length > 0}
				<!-- Standard-mode "Main chat model" picker (arch-v2 Simple view). Sets
				     `default_tier` (+ the Anthropic `balanced_model` variant) so the
				     user can move the main chat from e.g. Ministral to Mistral Large.
				     Options are server-computed (`main_chat_models`) — one per reachable
				     band — so the picker can never offer a model a tier-pick wouldn't
				     actually reach. Background tasks + subagents keep auto-routing. -->
				<div class="space-y-2">
					<label class="block">
						<span class="block text-sm font-medium mb-1">{t('llm.main_model.heading')}</span>
						<select value={mainModelSelection}
							disabled={!loaded || providerLocked}
							onchange={(e) => setMainModel(e.currentTarget.value)}
							aria-label={t('llm.main_model.heading')}
							class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
							{#each mainModelOptions as opt (mainModelOptionKey(opt))}
								<option value={mainModelOptionKey(opt)} disabled={opt.overCeiling}>
									{opt.label}{#if opt.pricing} — ${opt.pricing.input}/M in · ${opt.pricing.output}/M out{/if}{#if opt.expensive} ⚡{/if}{#if opt.notRecommended} · {t('llm.main_model.fast_suffix')}{/if}{#if opt.overCeiling} · {t('llm.main_model.locked_suffix')}{/if}
								</option>
							{/each}
						</select>
					</label>
					<p class="text-xs text-text-muted">{t('llm.main_model.applies_hint')}</p>
					<p class="text-xs text-text-muted">{t('llm.main_model.autoroute_hint')}</p>
				</div>
			{:else if (activeProviderEntry?.models.length ?? 0) === 0}
				<!--
					Any entry with an EMPTY model catalog needs an explicit model id —
					there is nothing to pick from, and the id is routed straight to the
					endpoint (see core/src/core/llm/catalog.ts). The backend rejects
					provider:'openai' without openai_model_id (http-api.ts), so without
					this field such a tile could never save (HTTP 400).

					Derived from `models.length`, NOT from a hardcoded key list. The old
					list named only 'custom' and 'openai-compat', so every gateway/local
					preset added later (Ollama, LM Studio, Groq, …) silently rendered no
					model field at all — selectable, unsaveable, and no way for the user
					to tell why. Anthropic / Mistral / Vertex ship catalogs and use the
					tier picker above instead.
				-->
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('llm.custom_model_id')}</span>
					<input type="text" disabled={!loaded || providerLocked}
						placeholder={activeProviderEntry?.model_placeholder ?? 'claude-3-5-sonnet-20241022'}
						bind:value={config.openai_model_id} oninput={markDirty}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
					<span class="text-xs text-text-muted">{t('llm.custom_model_id_hint')}</span>
				</label>
			{/if}

			<!-- Inline residency note — single-provider only; in Hybrid each tier's
			     residency is implied by its provider choice. -->
			{#if !hybridActive}
				<p class="text-xs text-text-muted">
					<span class="font-medium">{t('llm.residency')}:</span> {activeProviderEntry.default_residency}
				</p>
			{/if}

			<!-- Connection-test row — hidden on managed (CP-supplied key, can't
			     be re-tested by the customer; the engine probe still runs on
			     server start) and in Hybrid (no single provider to probe). -->
			{#if !cpSuppliesLLMKeyForInstance() && !hybridActive}
			<div class="flex items-center gap-3">
				<button type="button" onclick={testConnection} disabled={testing || providerLocked || !loaded}
					class="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent/5 disabled:opacity-50">
					{testing ? t('llm.testing') : t('llm.test_connection')}
				</button>
				{#if testResult?.ok}
					<span class="text-sm text-success">✓ {t('llm.test_ok')} · {testResult.latency_ms}ms</span>
				{:else if testResult && !testResult.ok}
					<span class="text-sm text-danger">✗ {testResult.message}</span>
				{/if}
			</div>
			{/if}
		</section>
		{/if}
	{/if}

	<!-- Unsaved-changes bar (rafael W4 explicit-save model): the ONE save
	     affordance. No auto-save anywhere — every change stages `dirty` and this bar
	     appears with Discard + Save. Reserved for real intent; the per-field toast is
	     gone. Gated on `dirty` alone — NOT on activeProviderEntry — so the save path
	     never disappears if the catalog fails to resolve a provider tile, and a
	     preset choice (whose card has no inline form) still commits here. -->
	{#if loaded && dirty}
			<div class="sticky bottom-2 z-10 flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-accent/40 bg-accent/5 px-3 py-2 shadow-sm backdrop-blur-sm">
				<span class="text-sm font-medium text-text">{t('llm.unsaved.title')}</span>
				<div class="flex items-center gap-2">
					<button type="button" onclick={discardChanges} disabled={saving}
						class="px-3 py-1.5 text-sm border border-border rounded-[var(--radius-md)] hover:bg-bg-muted disabled:opacity-50">
						{t('llm.unsaved.discard')}
					</button>
					<button type="button" onclick={saveConfig} disabled={saving || !loaded}
						class="px-4 py-1.5 text-sm bg-accent text-accent-fg rounded-[var(--radius-md)] hover:opacity-90 disabled:opacity-50">
						{saving ? t('llm.saving') : t('llm.save')}
					</button>
				</div>
			</div>
		{/if}

	{#if activeProviderEntry}
		<!-- Settings v3 PR 4.6 (Items 3 + 5): Advanced sub-page collapsed inline
		     as expandable section. The standalone /llm/advanced route stays for
		     back-compat with deep links; mounting LLMAdvancedView with
		     embedded=true reuses the same component without its page chrome.

		     Mount-on-expand pattern: `<details>` mounts its children eagerly,
		     which would fire a second /api/config fetch on every page load.
		     The `bind:open` + `{#if advancedOpen}` gate defers the mount until
		     the user actually clicks the summary, so the duplicate fetch only
		     happens when needed. -->
		<details bind:open={advancedOpen} class="border-t border-border pt-6 group">
			<summary class="cursor-pointer text-base font-medium text-text-muted hover:text-text transition-colors flex items-center gap-2 list-none">
				<svg class="w-4 h-4 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
					<path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
				</svg>
				{t('llm.advanced.expand_label')}
			</summary>
			<div class="mt-4 px-1">
				{#if advancedOpen}
					<!-- Pass the *pending* provider selection so the embedded
					     Advanced view's provider-aware sections (e.g. Nachdenken
					     visibility — Anthropic-only) re-render the moment the
					     user clicks a Provider Tile above, instead of waiting
					     for save+restart to update the persisted activeModel.
					     Per user-feedback 2026-05-25. -->
					<LLMAdvancedView embedded={true} pendingProvider={activeProvider} />
				{/if}
			</div>
		</details>
	{/if}
</div>

<!-- Wave 5d — BYOK Custom Endpoint Disclosure modal.
     Distinct from the test-connection confirm above: this gate fires on
     SAVE for any endpoint outside lynox's vetted sub-processor allowlist,
     and the user must tick "I understand and accept" before saving can
     proceed. Captures explicit GDPR-Art-28 controller-responsibility
     transfer for non-allowlisted third-party endpoints. -->
{#if pendingDisclosureUrl !== null}
	<div role="dialog" aria-modal="true" aria-labelledby="disclosure-title"
		class="fixed inset-0 z-50 flex items-center justify-center bg-bg-overlay/60 p-4">
		<div class="bg-bg border border-border rounded-lg shadow-xl max-w-md w-full p-6 space-y-4">
			<h3 id="disclosure-title" class="text-lg font-medium">
				{t('endpoint_disclosure_title')}
			</h3>
			<p class="text-sm">
				{t('endpoint_disclosure_body').replaceAll('{hostname}', disclosureHostname(pendingDisclosureUrl))}
			</p>
			<pre class="font-mono text-xs px-2 py-1 bg-bg-muted rounded break-all whitespace-pre-wrap">{pendingDisclosureUrl}</pre>
			<label class="flex items-start gap-2 text-sm cursor-pointer">
				<input type="checkbox" bind:checked={disclosureAccepted} class="mt-0.5" />
				<span>{t('endpoint_disclosure_accept')}</span>
			</label>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button"
					onclick={() => { pendingDisclosureUrl = null; disclosureAccepted = false; }}
					class="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent/5">
					{t('endpoint_disclosure_cancel')}
				</button>
				<button type="button"
					disabled={!disclosureAccepted}
					onclick={() => {
						pendingDisclosureUrl = null;
						disclosureAccepted = false;
						// Acceptance is recorded server-side by the PUT below
						// (confirm_custom_endpoint:true) — no client-only flag.
						void runSaveConfig();
					}}
					class="px-3 py-1.5 text-sm bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">
					{t('endpoint_disclosure_save')}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Custom-endpoint key-exfil confirm modal — fires per distinct URL,
     once per browser session. SSRF-guard handles private-IP exfil; this
     handles public attacker-URL exfil where the SSRF-guard wouldn't trigger. -->
{#if pendingTestUrl !== null}
	<div role="dialog" aria-modal="true" aria-labelledby="confirm-title"
		class="fixed inset-0 z-50 flex items-center justify-center bg-bg-overlay/60 p-4">
		<div class="bg-bg border border-border rounded-lg shadow-xl max-w-md w-full p-6 space-y-4">
			<h3 id="confirm-title" class="text-lg font-medium flex items-center gap-2">
				⚠ {t('llm.confirm_title')}
			</h3>
			<p class="text-sm">{t('llm.confirm_body_1')}</p>
			<pre class="font-mono text-xs px-2 py-1 bg-bg-muted rounded break-all whitespace-pre-wrap">{pendingTestUrl}</pre>
			<p class="text-sm text-warning">{t('llm.confirm_body_2')}</p>
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" onclick={() => { pendingTestUrl = null; }}
					class="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent/5">
					{t('llm.confirm_cancel')}
				</button>
				<button type="button"
					onclick={() => { const url = pendingTestUrl!; pendingTestUrl = null; markCustomUrlConfirmed(url); void runProbe(); }}
					class="px-3 py-1.5 text-sm bg-warning text-warning-fg rounded hover:opacity-90">
					{t('llm.confirm_proceed')}
				</button>
			</div>
		</div>
	</div>
{/if}
