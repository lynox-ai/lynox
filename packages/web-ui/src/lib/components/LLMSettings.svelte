<!--
	LLM Settings — provider + key + model + test (PRD-SETTINGS-REFACTOR Phase 2
	Principle 3: provider + model unified in one flow). Replaces the old
	Settings → Provider tab. Capability-gated via /api/config.locks.provider
	on managed tiers.

	Per-provider keys persist in vault under their canonical names
	(ANTHROPIC_API_KEY, MISTRAL_API_KEY, OPENAI_API_KEY) — switching providers
	does NOT delete keys, so users can flip back without re-entering.

	Tier-awareness audit (Settings v3 Item 2, 2026-05-19):
	| Setting               | Self-host | BYOK | Managed |
	|-----------------------|-----------|------|---------|
	| provider tile pick    | ✓         | ✓    | ✓ curated allowlist (Anthropic + Mistral) |
	| api_key field         | ✓         | ✓    | ✗ CP supplies → hidden |
	| api_base_url (custom) | ✓         | ✗    | ✗ locks.custom_provider_endpoints |
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
	import { isManaged, loadManagedStatus } from '../stores/integrations/managed.svelte.js';
	import LLMAdvancedView from './LLMAdvancedView.svelte';
	// Local enum mirror — the engine type lives in src/types/models.ts but
	// web-ui doesn't import core types directly (avoids dist/ rebuild churn).
	type LLMProvider = 'anthropic' | 'vertex' | 'openai' | 'custom';

	interface CatalogModel {
		id: string;
		tier?: string;
		label: string;
		context_window: number;
		pricing?: { input: number; output: number };
		residency: string;
		notes?: string;
	}
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
		requires_base_url: boolean;
		requires_region: boolean;
		default_residency: string;
		/** Pre-filled api_base_url for presets that pin a fixed endpoint. */
		base_url_default?: string;
		notes?: string;
	}

	function catalogEntryKey(entry: CatalogProvider): string {
		return entry.preset_id ?? entry.provider;
	}

	interface CustomEndpoint { id: string; name: string; base_url: string }

	interface UserConfig {
		provider?: LLMProvider;
		api_base_url?: string;
		gcp_project_id?: string;
		gcp_region?: string;
		default_tier?: string;
		openai_model_id?: string;
		custom_endpoints?: CustomEndpoint[];
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
	}

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
	 * Fallback order: single-entry → that entry; multi-preset without a
	 * match → the `requires_base_url` preset (so the user sees the input
	 * they need to fill in); else first candidate.
	 */
	function resolveCatalogKey(provider: LLMProvider, baseUrl?: string): string {
		const candidates = providers.filter((p) => p.provider === provider);
		if (candidates.length === 0) return provider;
		if (candidates.length === 1) return catalogEntryKey(candidates[0]!);
		if (baseUrl) {
			let host = '';
			try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { /* invalid */ }
			if (host) {
				const matched = candidates.find((c) => {
					if (!c.base_url_default) return false;
					let defHost = '';
					try { defHost = new URL(c.base_url_default).hostname.toLowerCase(); } catch { return false; }
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
			const configBody = (await configRes.json()) as UserConfig & { locks?: Locks };
			config = configBody;
			locks = configBody.locks ?? {};
			providerExplicit = typeof configBody.provider === 'string' && configBody.provider.length > 0;
			activeProvider = configBody.provider ?? 'anthropic';
			// Pick the matching catalog entry. For providers with multiple
			// presets (openai → mistral + openai-compat) we disambiguate from
			// the saved api_base_url: a Mistral host activates the Mistral
			// preset, anything else falls through to the generic OpenAI-compat
			// entry. Keeps round-trip consistent so a returning user lands on
			// the same button they last picked.
			activeCatalogKey = resolveCatalogKey(activeProvider, configBody.api_base_url);
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

	/**
	 * Return the {main, small} pair for the active provider's tier-set so
	 * the UI can show both models that will run (main for orchestration,
	 * small for fast sub-tasks). Pre-1.5.2 the picker only surfaced one
	 * model — users couldn't see that switching providers also swaps the
	 * small/fast model used in pipelines and spawn calls.
	 */
	function tierSetFor(entry: CatalogProvider | null | undefined, defaultTier?: string | undefined): { main: CatalogModel | null; small: CatalogModel | null } {
		if (!entry || !entry.models || entry.models.length === 0) {
			return { main: null, small: null };
		}
		// Main reflects the user's selected default_tier; fall back to the
		// sonnet tier (lynox's standard recommendation) then the first model.
		// Without this, picking "Magistral" in the tier picker would still show
		// "Main: Mistral Large" in the summary — confusing inconsistency.
		const main = (defaultTier ? entry.models.find((m) => m.tier === defaultTier) : undefined)
			?? entry.models.find((m) => m.tier === 'sonnet')
			?? entry.models[0]
			?? null;
		const small = entry.models.find((m) => m.tier === 'haiku') ?? null;
		return { main, small };
	}

	function selectCatalogEntry(entry: CatalogProvider): void {
		if (isTileLocked(entry)) {
			addToast(t('llm.locked_provider'), 'info', 3000);
			return;
		}
		activeProvider = entry.provider;
		activeCatalogKey = catalogEntryKey(entry);
		// Fix A (v1.5.2): auto-default the main-tier model for the new
		// provider's catalog so the <select bind:value={openai_model_id}>
		// renders the right option highlighted instead of blank. Pre-fix
		// rafael-prod 2026-05-18: switching to Mistral left openai_model_id
		// empty, the dropdown looked unselected, and "Verbindung testen"
		// failed because no model was wired.
		const defaultForNewProvider = pickDefaultModelIdForEntry(entry);
		if (entry.base_url_default && !entry.requires_base_url) {
			// Pinned preset (e.g. Mistral → api.mistral.ai). Stamp it so
			// save→reload round-trips back to this preset and the user
			// doesn't have to type a URL they didn't choose.
			config = {
				...config,
				api_base_url: entry.base_url_default,
				...(defaultForNewProvider ? { openai_model_id: defaultForNewProvider } : {}),
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
		if (!entry.requires_base_url && loaded) {
			void saveConfig();
		}
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
			const slot = slotFor(activeProvider);
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

	async function saveConfig(): Promise<void> {
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
					openai_model_id: config.openai_model_id,
					custom_endpoints: config.custom_endpoints,
				},
			});
			// Advanced / Memory / Context-Window have moved to /settings/llm/advanced
			// and /settings/llm/memory (PRD-IA-V2 P3-PR-C) — their save paths live on
			// those views and PUT the same /api/config endpoint.
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(update),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('llm.saved'), 'success', 3000);
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
	const providerLocked = $derived(!!locks.provider);
	const customEndpointsLocked = $derived(!!locks.custom_provider_endpoints);

	// Per-tile predicate (P3-FOLLOWUP-HOTFIX): replaces the binary providerLocked
	// gate on tile click. On Managed, only free-text endpoints (`requires_base_url`)
	// are off-limits; the curated tiles (Anthropic, Mistral) stay interactive.
	// `providerLocked` (operator hard-lock) still blanket-disables everything.
	function isTileLocked(entry: CatalogProvider): boolean {
		if (providerLocked && catalogEntryKey(entry) !== activeCatalogKey) return true;
		if (customEndpointsLocked && entry.requires_base_url) return true;
		return false;
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
		// v1.5.2: API keys for 3rd-party tools (Tavily, DataForSEO, …) moved
		// to /app/hub?section=keys so they live next to API Profile endpoints.
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

	<!-- Provider picker — Anthropic / Mistral / Custom. P3-FOLLOWUP-HOTFIX:
	     moved to the top of the page so the user sees the selection control
	     before the sub-route nav. Vertex is wired in the engine for legacy
	     `provider: 'vertex'` config.json setups (see core CLAUDE.md) but no
	     longer offered in-product per project_eu_providers_strategy — filter
	     it out of the tile list. -->
	<section aria-labelledby="llm-provider-heading">
		<h2 id="llm-provider-heading" class="text-lg font-medium mb-3">{t('llm.provider_heading')}</h2>
		<div class="grid gap-2 sm:grid-cols-2">
			{#each providers.filter((p) => p.provider !== 'vertex' || activeProvider === 'vertex') as p (catalogEntryKey(p))}
				<button type="button" onclick={() => selectCatalogEntry(p)} disabled={isTileLocked(p)}
					class="text-left p-3 rounded border-2 transition-colors {catalogEntryKey(p) === activeCatalogKey ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'} disabled:opacity-50 disabled:cursor-not-allowed">
					<div class="font-medium text-sm">{p.display_name}</div>
					<div class="text-xs text-text-muted mt-0.5">{p.default_residency}</div>
				</button>
			{/each}
		</div>
	</section>

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
		<!-- Per-provider config form -->
		<section aria-labelledby="llm-config-heading" class="border-t border-border pt-6 space-y-4">
			<h2 id="llm-config-heading" class="text-lg font-medium">{activeProviderEntry.display_name}</h2>
			{#if activeProviderEntry.notes}
				<p class="text-xs text-text-muted">{activeProviderEntry.notes}</p>
			{/if}

			{#if slotFor(activeProviderEntry.provider) && !isManaged()}
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('llm.api_key')}</span>
					<input type="password" autocomplete="off" disabled={!loaded || providerLocked}
						placeholder={t('llm.api_key_placeholder')}
						bind:value={keys[slotFor(activeProviderEntry.provider)]}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
					<span class="text-xs text-text-muted">{t('llm.api_key_hint')}</span>
				</label>
			{:else if isManaged()}
				<!-- v1.5.2: on managed tiers, the CP supplies the LLM key — the
				     input would be misleading-disabled. Replace with a short
				     note so the user knows why the field is missing. -->
				<p class="text-xs text-text-muted rounded border border-border/50 bg-bg-subtle px-3 py-2">
					{t('llm.api_key_managed_note')}
				</p>
			{/if}

			{#if activeProviderEntry.requires_base_url}
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('llm.base_url')}</span>
					<input type="url" disabled={!loaded || providerLocked}
						placeholder="https://api.mistral.ai/v1"
						bind:value={config.api_base_url}
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

			{#if activeProviderEntry.requires_region}
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

			{#if activeProviderEntry.models.length > 0}
				<!-- Default-tier picker for every tier-aware provider with a catalog
				     (Anthropic + Mistral). Binds to `default_tier` which IS
				     runtime-meaningful — sets the starting orchestration tier
				     before auto-downgrade. On Mistral, the tier maps via
				     MISTRAL_MODEL_MAP: sonnet→Large, opus→Magistral, haiku→Small.
				     v1.5.2 parity (rafael QA 2026-05-18): Mistral previously had
				     no picker because the old single-model dropdown wrote
				     openai_model_id (no runtime effect). Now the tier-bound picker
				     gives Mistral users the same control as Anthropic users have. -->
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('llm.default_tier_heading')}</span>
					<select disabled={!loaded || providerLocked} bind:value={config.default_tier}
						class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
						{#each activeProviderEntry.models as m (m.id)}
							<option value={m.tier ?? m.id}>{m.label} — ${m.pricing?.input ?? '?'}/M in, ${m.pricing?.output ?? '?'}/M out</option>
						{/each}
					</select>
				</label>
				<!--
					Pre-1.5.2 Mistral had a separate single-model dropdown that wrote
					openai_model_id — but that field is only consulted as a fallback
					when a tier is missing from MISTRAL_MODEL_MAP. All three Mistral
					tiers (sonnet→Large, haiku→Small, opus→Magistral) are mapped,
					so the dropdown value was never actually used. Users picked
					"Magistral Medium" and the engine still routed to Mistral Large.
					Replaced with the unified default-tier picker above + the
					tier-set summary block below (single source of truth).
					single source of truth and lynox routes automatically per turn.
				-->
			{:else if activeProvider === 'custom'}
				<!--
					Custom (Anthropic-compatible) endpoints have no enumerated model
					catalog (see core/src/core/llm/catalog.ts:158) — model id is
					free-text routed by the proxy. The legacy ConfigView lost this
					field entirely, leaving custom users stuck with whatever the
					wizard set. P1-PR-A1 surfaces it explicitly.
				-->
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('llm.custom_model_id')}</span>
					<input type="text" disabled={!loaded || providerLocked}
						placeholder="claude-3-5-sonnet-20241022"
						bind:value={config.openai_model_id}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
					<span class="text-xs text-text-muted">{t('llm.custom_model_id_hint')}</span>
				</label>
			{/if}

			{#if activeProviderEntry.models.length > 0}
				{@const tierSet = tierSetFor(activeProviderEntry, config.default_tier)}
				{#if tierSet.main && tierSet.small}
					<!--
						Fix D (v1.5.2): make the provider's tier-set visible. lynox dispatches
						orchestration on the "main" tier (Sonnet → Claude Sonnet 4.6 / Mistral
						Large) and sub-tasks on the "small" tier (Haiku → Claude Haiku 4.5 /
						Mistral Small). Pre-fix the UI only surfaced one dropdown, so users
						didn't know what model their pipeline / spawn calls were actually
						hitting after a provider switch.
					-->
					<div class="rounded border border-border bg-bg-subtle px-3 py-2 text-xs space-y-1.5">
						<div class="font-medium text-text-muted">{t('llm.tier_set_heading')}</div>
						<div class="flex flex-wrap gap-x-4 gap-y-1">
							<span>
								<span class="text-text-muted">{t('llm.tier_main')}:</span>
								<span class="font-mono">{tierSet.main.label}</span>
							</span>
							<span>
								<span class="text-text-muted">{t('llm.tier_small')}:</span>
								<span class="font-mono">{tierSet.small.label}</span>
							</span>
						</div>
						<div class="text-text-muted">{t('llm.tier_set_routing_hint')}</div>
					</div>
				{/if}
			{/if}

			<!-- Inline residency note -->
			<p class="text-xs text-text-muted">
				<span class="font-medium">{t('llm.residency')}:</span> {activeProviderEntry.default_residency}
			</p>

			<!-- Connection-test row — hidden on managed (CP-supplied key, can't
			     be re-tested by the customer; the engine probe still runs on
			     server start). -->
			{#if !isManaged()}
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

		<!-- Save row — provider / model / custom-endpoint changes only. Memory
		     still saves from its own sub-page (Foundation-Rework may re-home).
		     Advanced (PR 4.6, 2026-05-19) collapses inline below. -->
		<div class="flex justify-end">
			<button type="button" onclick={saveConfig} disabled={saving || !loaded}
				class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
				{saving ? t('llm.saving') : t('llm.save')}
			</button>
		</div>

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
					<LLMAdvancedView embedded={true} />
				{/if}
			</div>
		</details>
	{/if}
</div>

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
