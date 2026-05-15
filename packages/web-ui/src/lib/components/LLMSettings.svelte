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
		display_name: string;
		models: CatalogModel[];
		requires_base_url: boolean;
		requires_region: boolean;
		default_residency: string;
		notes?: string;
	}

	interface UserConfig {
		provider?: LLMProvider;
		api_base_url?: string;
		gcp_project_id?: string;
		gcp_region?: string;
		default_tier?: string;
		openai_model_id?: string;
	}

	interface Locks {
		provider?: { reason: string; upgrade_cta?: { href: string; label: string } };
	}

	let providers = $state<CatalogProvider[]>([]);
	let config = $state<UserConfig>({});
	let locks = $state<Locks>({});
	let activeProvider = $state<LLMProvider | null>(null);
	// Per-provider key cache (UI-only — kept in vault, sent on save).
	let keys = $state<Record<string, string>>({});
	let loaded = $state(false);
	let testing = $state(false);
	let saving = $state(false);
	let testResult = $state<{ ok: boolean; latency_ms?: number; message?: string } | null>(null);

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

	async function load(): Promise<void> {
		try {
			const [catRes, configRes] = await Promise.all([
				fetch(`${getApiBase()}/llm/catalog`),
				fetch(`${getApiBase()}/config`),
			]);
			if (!catRes.ok || !configRes.ok) throw new Error(`HTTP ${catRes.status} / ${configRes.status}`);
			const catBody = (await catRes.json()) as { providers: CatalogProvider[] };
			providers = catBody.providers;
			const configBody = (await configRes.json()) as UserConfig & { locks?: Locks };
			config = configBody;
			locks = configBody.locks ?? {};
			activeProvider = configBody.provider ?? 'anthropic';
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('llm.load_failed'), 'error', 5000);
		}
	}

	function selectProvider(p: LLMProvider): void {
		if (locks.provider) {
			addToast(t('llm.locked_provider'), 'info', 3000);
			return;
		}
		activeProvider = p;
		testResult = null;
	}

	async function testConnection(): Promise<void> {
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
			// 1. Save keys to vault first (only if non-empty — empty means keep existing)
			for (const [slot, value] of Object.entries(keys)) {
				if (value.length > 0) {
					await fetch(`${getApiBase()}/secrets/${slot}`, {
						method: 'PUT',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ value }),
					});
				}
			}
			// 2. Save provider + tier + base_url to config
			const update: UserConfig = { provider: activeProvider };
			if (activeProviderEntry?.requires_base_url && config.api_base_url) {
				update.api_base_url = config.api_base_url;
			}
			if (activeProviderEntry?.requires_region) {
				update.gcp_project_id = config.gcp_project_id;
				update.gcp_region = config.gcp_region;
			}
			if (config.default_tier) update.default_tier = config.default_tier;
			if (activeProvider === 'openai' && config.openai_model_id) {
				update.openai_model_id = config.openai_model_id;
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

	const activeProviderEntry = $derived(providers.find((p) => p.provider === activeProvider));
	const providerLocked = $derived(!!locks.provider);
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
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

	<!-- Provider picker — 4 cards. Active one expands inline. -->
	<section aria-labelledby="llm-provider-heading">
		<h2 id="llm-provider-heading" class="text-lg font-medium mb-3">{t('llm.provider_heading')}</h2>
		<div class="grid gap-2 sm:grid-cols-2">
			{#each providers as p (p.provider)}
				<button type="button" onclick={() => selectProvider(p.provider)} disabled={providerLocked && p.provider !== activeProvider}
					class="text-left p-3 rounded border-2 transition-colors {activeProvider === p.provider ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'} disabled:opacity-50 disabled:cursor-not-allowed">
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

		<!-- Save row -->
		<div class="flex justify-end">
			<button type="button" onclick={saveConfig} disabled={saving || providerLocked || !loaded}
				class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
				{saving ? t('llm.saving') : t('llm.save')}
			</button>
		</div>
	{/if}
</div>
