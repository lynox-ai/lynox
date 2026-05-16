<!--
	LLM Settings — provider + key + model + test (PRD-SETTINGS-REFACTOR Phase 2
	Principle 3: provider + model unified in one flow). Replaces the old
	Settings → Provider tab. Capability-gated via /api/config.locks.provider
	on managed tiers.

	Per-provider keys persist in vault under their canonical names
	(ANTHROPIC_API_KEY, MISTRAL_API_KEY, OPENAI_API_KEY) — switching providers
	does NOT delete keys, so users can flip back without re-entering.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
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

	function catalogKey(entry: CatalogProvider): string {
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
		// Advanced / Memory backfill (PRD-IA-V2 P1-PR-A1) — moved out of legacy
		// ConfigView. Schema source-of-truth: core/src/types/schemas.ts.
		experience?: 'business' | 'developer';
		effort_level?: 'low' | 'medium' | 'high' | 'max';
		thinking_mode?: 'adaptive' | 'disabled';
		embedding_provider?: 'onnx' | 'local';
		llm_mode?: 'standard' | 'eu-sovereign';
		memory_extraction?: boolean;
		memory_half_life_days?: number;
		// Context-window (PRD-IA-V2 P2-PR-C interim move from CostLimits). Same field
		// the backend has always read — both /app/hub/cost-limits and /settings/llm
		// PUT to /api/config, no schema change. Final route lands in P3-PR-C.
		max_context_window_tokens?: number;
		managed?: string;
		capabilities?: { mistral_available?: boolean };
	}

	interface Locks {
		provider?: { reason: string; upgrade_cta?: { href: string; label: string } };
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
	 * pair. Falls back to the first catalog entry for that provider when no
	 * preset matches — keeps single-entry providers (anthropic, vertex,
	 * custom) working without preset_id.
	 */
	function resolveCatalogKey(provider: LLMProvider, baseUrl?: string): string {
		const candidates = providers.filter((p) => p.provider === provider);
		if (candidates.length === 0) return provider;
		if (candidates.length === 1) return catalogKey(candidates[0]!);
		// Multi-preset provider — pick the preset whose `base_url_default`
		// the saved api_base_url points at (hostname match, not substring;
		// mirrors getOpenAIModelMap in core/src/types/models.ts).
		if (baseUrl) {
			try {
				const host = new URL(baseUrl).hostname.toLowerCase();
				const matched = candidates.find((c) => {
					if (!c.base_url_default) return false;
					try {
						const defHost = new URL(c.base_url_default).hostname.toLowerCase();
						return host === defHost || host.endsWith(`.${defHost.replace(/^api\./, '')}`);
					} catch { return false; }
				});
				if (matched) return catalogKey(matched);
			} catch { /* invalid URL — fall through to fallback */ }
		}
		// No baseUrl OR no preset matched → fall back to the catalog entry
		// that REQUIRES a base URL (the generic-fallback preset), so the
		// user sees the input they need to fill in.
		const generic = candidates.find((c) => c.requires_base_url);
		return catalogKey(generic ?? candidates[0]!);
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

	function selectCatalogEntry(entry: CatalogProvider): void {
		if (locks.provider) {
			addToast(t('llm.locked_provider'), 'info', 3000);
			return;
		}
		activeProvider = entry.provider;
		activeCatalogKey = catalogKey(entry);
		// Pre-fill api_base_url for presets that pin a fixed endpoint
		// (e.g. Mistral → api.mistral.ai). Keeps the user from having to
		// type it AND ensures save→reload round-trips back to this preset.
		if (entry.base_url_default && !entry.requires_base_url) {
			config = { ...config, api_base_url: entry.base_url_default };
		} else if (entry.requires_base_url && config.api_base_url === entry.base_url_default) {
			// Switching from a pinned preset (Mistral) to a free-text one
			// (openai-compat) — clear the pre-filled URL so the input
			// renders blank instead of inheriting the previous preset's
			// host.
			config = { ...config, api_base_url: '' };
		}
		testResult = null;
	}

	function selectProvider(p: LLMProvider): void {
		if (locks.provider) {
			addToast(t('llm.locked_provider'), 'info', 3000);
			return;
		}
		activeProvider = p;
		testResult = null;
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
			// 2. Save config. Provider-bound fields only stage when the user can change
			// them. On managed-tier the CP locks provider; sending provider-bound
			// fields runs them through the lock-gate's effective-default diff and
			// any tiny drift (e.g. llm_mode that has no MANAGED_EFFECTIVE_DEFAULTS
			// entry) returns 403, silently breaking the entire save.
			const update: UserConfig = {};
			if (!providerLocked && activeProvider) {
				update.provider = activeProvider;
				// Send api_base_url for both free-text presets (requires_base_url)
				// AND pinned presets (base_url_default — e.g. Mistral). Without
				// the second case a user picking "Mistral" would save without
				// the api.mistral.ai host, and the engine would default to
				// Anthropic Direct.
				if (activeProviderEntry?.requires_base_url && config.api_base_url) {
					update.api_base_url = config.api_base_url;
				} else if (activeProviderEntry?.base_url_default) {
					update.api_base_url = activeProviderEntry.base_url_default;
				}
				if (activeProviderEntry?.requires_region) {
					update.gcp_project_id = config.gcp_project_id;
					update.gcp_region = config.gcp_region;
				}
				if (config.default_tier) update.default_tier = config.default_tier;
				// `openai_model_id` covers BOTH 'openai' (Mistral / generic OpenAI-compat)
				// AND 'custom' (Anthropic-compat proxies via LiteLLM etc.) — engine reads
				// the same field for both (engine.ts:307, session.ts:968).
				if ((activeProvider === 'openai' || activeProvider === 'custom') && config.openai_model_id) {
					update.openai_model_id = config.openai_model_id;
				}
				if (activeProvider === 'custom') {
					update.custom_endpoints = config.custom_endpoints ?? [];
				}
				// llm_mode is admin-only on managed (per project_managed_llm_strategy:
				// "eu-sovereign admin-only"); self-host with Mistral wired = user-pickable.
				if (config.llm_mode) update.llm_mode = config.llm_mode;
				// embedding_provider is self-host only (ONNX); managed doesn't expose it.
				if (config.embedding_provider) update.embedding_provider = config.embedding_provider;
			}
			// Advanced + Memory — managed-allowlist-writable per MANAGED_USER_WRITABLE_CONFIG.
			if (config.experience) update.experience = config.experience;
			if (config.effort_level) update.effort_level = config.effort_level;
			if (config.thinking_mode) update.thinking_mode = config.thinking_mode;
			if (typeof config.memory_extraction === 'boolean') update.memory_extraction = config.memory_extraction;
			if (typeof config.memory_half_life_days === 'number' && config.memory_half_life_days > 0) {
				update.memory_half_life_days = config.memory_half_life_days;
			}
			// Context-window: `undefined` is a meaningful value (= model default), so
			// we send the field whenever the radio has been touched (i.e. the key is
			// present on `config`). Backend reads `max_context_window_tokens` from the
			// same /api/config endpoint as CostLimits.svelte — single SSoT.
			if ('max_context_window_tokens' in config) {
				update.max_context_window_tokens = config.max_context_window_tokens;
			}
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

	const activeProviderEntry = $derived(
		providers.find((p) => catalogKey(p) === activeCatalogKey)
		?? providers.find((p) => p.provider === activeProvider),
	);
	const providerLocked = $derived(!!locks.provider);

	// Capability gate for the llm_mode toggle — mirrors ConfigView's same-name
	// derived. Hidden until the engine reports a working Mistral path, so the
	// radio doesn't tease BYOK self-hosters who don't have Mistral wired.
	const mistralAvailable = $derived(config.capabilities?.mistral_available === true);
	// Managed tiers can't write embedding_provider + max_http_requests_per_hour
	// (allowlist gate in http-api.ts MANAGED_USER_WRITABLE_CONFIG); hide those
	// inputs on managed to avoid the silent-403 trap.
	const isManaged = $derived(config.managed === 'managed' || config.managed === 'managed_pro' || config.managed === 'eu');
	// Empty-state CTA (PRD acceptance: fresh ~/.lynox/config.json → SetupBanner
	// → click → lands on /settings/llm empty-state). Triggers when neither a
	// provider was persisted to config.json nor an LLM key exists in the vault.
	// Conservative: hide the CTA when /secrets/status is unreachable (apiKeyConfigured===null).
	const showEmptyState = $derived(
		loaded && !providerLocked && !providerExplicit && apiKeyConfigured === false,
	);

	// Memory-section toggle (collapsible — final `/llm/memory` route lands in P3-PR-C).
	let memoryOpen = $state(false);
	let advancedOpen = $state(false);

	// Context-window radio options (PRD-IA-V2 P2-PR-C). Mirrors `CONTEXT_OPTIONS`
	// in CostLimits.svelte; both surfaces write the same backend field. Kept in
	// sync here rather than hoisted to a shared util so the lift can be deleted
	// cleanly when P3-PR-X removes the CostLimits-Page copy.
	const CONTEXT_OPTIONS: ReadonlyArray<{ value: number | undefined; labelKey: string; hintKey: string }> = [
		{ value: undefined,  labelKey: 'llm.context_window.option.default', hintKey: 'llm.context_window.option.default_hint' },
		{ value: 200_000,    labelKey: 'llm.context_window.option.200k',    hintKey: 'llm.context_window.option.200k_hint' },
		{ value: 500_000,    labelKey: 'llm.context_window.option.500k',    hintKey: 'llm.context_window.option.500k_hint' },
		{ value: 1_000_000,  labelKey: 'llm.context_window.option.1m',      hintKey: 'llm.context_window.option.1m_hint' },
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

	<!-- Generic API-Keys (Tavily / Brevo / custom) live on their own sub-page. -->
	<div class="text-xs text-text-muted">
		<a href="/app/settings/llm/keys" class="text-accent-text underline hover:opacity-90">{t('secrets.link_to_keys')}</a>
		— {t('secrets.link_to_keys_hint')}
	</div>

	<!-- Provider picker — Anthropic / Mistral / Custom. Vertex is wired in the
	     engine for legacy `provider: 'vertex'` config.json setups (see core
	     CLAUDE.md) but no longer offered in-product per
	     project_eu_providers_strategy — filter it out of the tile list. -->
	<section aria-labelledby="llm-provider-heading">
		<h2 id="llm-provider-heading" class="text-lg font-medium mb-3">{t('llm.provider_heading')}</h2>
		<div class="grid gap-2 sm:grid-cols-2">
			{#each providers.filter((p) => p.provider !== 'vertex' || activeProvider === 'vertex') as p (catalogKey(p))}
				<button type="button" onclick={() => selectCatalogEntry(p)} disabled={providerLocked && catalogKey(p) !== activeCatalogKey}
					class="text-left p-3 rounded border-2 transition-colors {catalogKey(p) === activeCatalogKey ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'} disabled:opacity-50 disabled:cursor-not-allowed">
					<div class="font-medium text-sm">{p.display_name}</div>
					<div class="text-xs text-text-muted mt-0.5">{p.default_residency}</div>
				</button>
			{/each}
		</div>
	</section>

	{#if activeProviderEntry}
		<!-- Per-provider config form -->
		<section aria-labelledby="llm-config-heading" class="border-t border-border pt-6 space-y-4">
			<h2 id="llm-config-heading" class="text-lg font-medium">{activeProviderEntry.display_name}</h2>
			{#if activeProviderEntry.notes}
				<p class="text-xs text-text-muted">{activeProviderEntry.notes}</p>
			{/if}

			{#if slotFor(activeProviderEntry.provider)}
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('llm.api_key')}</span>
					<input type="password" autocomplete="off" disabled={!loaded || providerLocked}
						placeholder={t('llm.api_key_placeholder')}
						bind:value={keys[slotFor(activeProviderEntry.provider)]}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
					<span class="text-xs text-text-muted">{t('llm.api_key_hint')}</span>
				</label>
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
				<label class="block">
					<span class="block text-sm font-medium mb-1">{t('llm.model')}</span>
					{#if activeProvider === 'openai'}
						<select disabled={!loaded || providerLocked} bind:value={config.openai_model_id}
							class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
							{#each activeProviderEntry.models as m (m.id)}
								<option value={m.id}>{m.label} — ${m.pricing?.input ?? '?'}/M in, ${m.pricing?.output ?? '?'}/M out</option>
							{/each}
						</select>
					{:else}
						<select disabled={!loaded || providerLocked} bind:value={config.default_tier}
							class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
							{#each activeProviderEntry.models as m (m.id)}
								<option value={m.tier ?? m.id}>{m.label} — ${m.pricing?.input ?? '?'}/M in, ${m.pricing?.output ?? '?'}/M out</option>
							{/each}
						</select>
					{/if}
				</label>
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

			<!-- Inline residency note -->
			<p class="text-xs text-text-muted">
				<span class="font-medium">{t('llm.residency')}:</span> {activeProviderEntry.default_residency}
			</p>

			<!-- Connection-test row -->
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
		</section>

		<!--
			Advanced section — backfilled from legacy ConfigView (PRD-IA-V2 P1-PR-A1).
			Collapsible to keep the picker-flow visually clean; final dedicated
			sub-route `/settings/llm/advanced` lands in P3-PR-C.
		-->
		<section aria-labelledby="llm-advanced-heading" class="border-t border-border pt-4 space-y-4">
			<button type="button" onclick={() => { advancedOpen = !advancedOpen; }}
				class="flex items-center gap-2 text-left w-full"
				aria-expanded={advancedOpen} aria-controls="llm-advanced-body">
				<span class="text-sm font-medium">{t('llm.advanced_heading')}</span>
				<span class="text-xs text-text-muted">{advancedOpen ? '▾' : '▸'}</span>
			</button>
			{#if advancedOpen}
				<div id="llm-advanced-body" class="space-y-4">
					<!-- LLM mode (capability-gated): only render when Mistral path is
					     wired AND the user can actually change provider. On managed
					     tiers the provider is locked and eu-sovereign is admin-only
					     (per project_managed_llm_strategy), so this radio would be
					     visually live but silently 403 the save. Hiding it removes
					     the dual-model-picker confusion. -->
					{#if mistralAvailable && !providerLocked}
						<fieldset class="space-y-2 border border-border rounded p-3">
							<legend class="px-1 text-xs font-medium uppercase tracking-wider text-text-muted">{t('config.llm_mode')}</legend>
							<p class="text-xs text-text-muted">{t('config.llm_mode_desc')}</p>
							<label class="flex items-start gap-3 p-2 rounded border border-border bg-bg cursor-pointer">
								<input type="radio" name="llm-mode" value="standard"
									checked={(config.llm_mode ?? 'standard') === 'standard'}
									onchange={() => { config.llm_mode = 'standard'; }}
									class="mt-1 accent-accent shrink-0" />
								<span class="text-sm">
									<span class="font-medium block">{t('config.llm_mode_standard')}</span>
									<span class="text-xs text-text-muted">{t('config.llm_mode_standard_desc')}</span>
								</span>
							</label>
							<label class="flex items-start gap-3 p-2 rounded border border-border bg-bg cursor-pointer">
								<input type="radio" name="llm-mode" value="eu-sovereign"
									checked={config.llm_mode === 'eu-sovereign'}
									onchange={() => { config.llm_mode = 'eu-sovereign'; }}
									class="mt-1 accent-accent shrink-0" />
								<span class="text-sm">
									<span class="font-medium block">{t('config.llm_mode_eu_sovereign')}</span>
									<span class="text-xs text-text-muted">{t('config.llm_mode_eu_sovereign_desc')}</span>
								</span>
							</label>
							<p class="text-xs text-text-muted italic">{t('config.llm_mode_restart_required')}</p>
						</fieldset>
					{/if}

					<label class="block">
						<span class="block text-sm font-medium mb-1">{t('config.effort')}</span>
						<span class="block text-xs text-text-muted mb-1">{t('config.effort_desc')}</span>
						<select bind:value={config.effort_level} disabled={!loaded}
							class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
							<option value="low">{t('config.effort_low')}</option>
							<option value="medium">{t('config.effort_medium')}</option>
							<option value="high">{t('config.effort_high')}</option>
							<option value="max">{t('config.effort_max')}</option>
						</select>
					</label>

					<label class="block">
						<span class="block text-sm font-medium mb-1">{t('config.thinking')}</span>
						<span class="block text-xs text-text-muted mb-1">{t('config.thinking_desc')}</span>
						<select bind:value={config.thinking_mode} disabled={!loaded}
							class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
							<option value="disabled">{t('config.thinking_disabled')}</option>
							<option value="adaptive">{t('config.thinking_adaptive')}</option>
						</select>
					</label>

					<label class="block">
						<span class="block text-sm font-medium mb-1">{t('config.experience')}</span>
						<span class="block text-xs text-text-muted mb-1">{t('config.experience_desc')}</span>
						<select bind:value={config.experience} disabled={!loaded}
							class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
							<option value="business">{t('config.experience_business')}</option>
							<option value="developer">{t('config.experience_developer')}</option>
						</select>
					</label>

					{#if !isManaged}
						<!-- embedding_provider is not in MANAGED_USER_WRITABLE_CONFIG (http-api.ts:175).
						     Hiding on managed avoids the silent-403 UX trap. -->
						<label class="block">
							<span class="block text-sm font-medium mb-1">{t('config.embedding_provider')}</span>
							<select bind:value={config.embedding_provider} disabled={!loaded}
								class="w-full px-2 py-1 border border-border rounded bg-bg disabled:opacity-50">
								<option value="onnx">{t('config.embedding_onnx')}</option>
							</select>
						</label>
					{/if}
				</div>
			{/if}
		</section>

		<!--
			Memory section — backfilled from legacy ConfigView (PRD-IA-V2 P1-PR-A1).
			Final dedicated sub-route `/settings/llm/memory` lands in P3-PR-C; for
			now this lives as a collapsible panel on the LLM page so the settings
			don't go missing between ConfigView delete (P1-PR-A2) and Phase 3.
		-->
		<section aria-labelledby="llm-memory-heading" class="border-t border-border pt-4 space-y-4">
			<button type="button" onclick={() => { memoryOpen = !memoryOpen; }}
				class="flex items-center gap-2 text-left w-full"
				aria-expanded={memoryOpen} aria-controls="llm-memory-body">
				<span class="text-sm font-medium">{t('llm.memory_heading')}</span>
				<span class="text-xs text-text-muted">{memoryOpen ? '▾' : '▸'}</span>
			</button>
			{#if memoryOpen}
				<div id="llm-memory-body" class="space-y-4">
					<div class="flex items-center justify-between gap-3">
						<div>
							<p class="text-sm font-medium">{t('config.memory_extraction')}</p>
							<p class="text-xs text-text-muted mt-0.5">{t('config.memory_extraction_desc')}</p>
						</div>
						<button type="button"
							onclick={() => { config.memory_extraction = !config.memory_extraction; }}
							disabled={!loaded}
							aria-pressed={config.memory_extraction === true}
							aria-label={t('config.memory_extraction')}
							class="relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 {config.memory_extraction ? 'bg-accent' : 'bg-border'}">
							<span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform {config.memory_extraction ? 'translate-x-4' : ''}"></span>
						</button>
					</div>

					<label class="block">
						<span class="block text-sm font-medium mb-1">{t('config.memory_half_life')}</span>
						<span class="block text-xs text-text-muted mb-1">{t('config.memory_half_life_desc')}</span>
						<input type="number" min="1" max="3650" placeholder="90"
							bind:value={config.memory_half_life_days} disabled={!loaded}
							class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
					</label>
				</div>
			{/if}
		</section>

		<!--
			Context-window section — interim move from /app/hub/cost-limits
			(PRD-IA-V2 P2-PR-C). Both surfaces remain functional during the
			interim; final dedicated sub-route `/settings/llm/advanced` lands
			in P3-PR-C, after which the radio leaves the CostLimits-Page.
		-->
		<section aria-labelledby="llm-context-window-heading" class="border-t border-border pt-6">
			<h2 id="llm-context-window-heading" class="text-lg font-medium mb-1">{t('llm.context_window.heading')}</h2>
			<p class="text-xs text-text-muted mb-3">{t('llm.context_window.description')}</p>
			<div class="space-y-2">
				{#each CONTEXT_OPTIONS as opt (opt.value ?? 'default')}
					<label class="flex items-start gap-3 cursor-pointer">
						<input type="radio" name="llm-context-window" value={opt.value}
							bind:group={config.max_context_window_tokens}
							disabled={!loaded} class="mt-1 disabled:opacity-50" />
						<div class="flex-1">
							<div class="text-sm font-medium">{t(opt.labelKey)}</div>
							<div class="text-xs text-text-muted">{t(opt.hintKey)}</div>
						</div>
					</label>
				{/each}
			</div>
		</section>

		<!-- Save row — on managed-tier the provider is locked but Advanced /
		     Memory / Context-Window are user-writable (MANAGED_USER_WRITABLE_CONFIG).
		     The button used to disable on `providerLocked` and stranded managed
		     users on the page with no way to persist context-window changes.
		     Save-handler itself already gates locked fields (see line ~218). -->
		<div class="flex justify-end">
			<button type="button" onclick={saveConfig} disabled={saving || !loaded}
				class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
				{saving ? t('llm.saving') : t('llm.save')}
			</button>
		</div>
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
