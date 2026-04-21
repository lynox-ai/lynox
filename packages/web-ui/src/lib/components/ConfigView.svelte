<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { clearError } from '../stores/chat.svelte.js';

	interface Config {
		provider?: string;
		gcp_region?: string;
		gcp_project_id?: string;
		api_base_url?: string;
		default_tier?: string;
		effort_level?: string;
		thinking_mode?: string;
		experience?: string;
		memory_extraction?: boolean;
		max_session_cost_usd?: number | undefined;
		max_daily_cost_usd?: number | undefined;
		max_monthly_cost_usd?: number | undefined;
		backup_schedule?: string | undefined;
		backup_encrypt?: boolean;
		backup_retention_days?: number | undefined;
		memory_half_life_days?: number | undefined;
		embedding_provider?: string;
		max_http_requests_per_hour?: number | undefined;
		search_provider?: string;
		update_check?: boolean;
		managed?: string; // 'starter' (Hosted/BYOK) | 'managed' | 'managed_pro' | 'eu' (legacy) | undefined (self-hosted)
		llm_mode?: 'standard' | 'eu-sovereign'; // managed-instance toggle: Anthropic Claude vs Mistral Large 3
		[key: string]: unknown;
	}

	// ── Config state ───────────────────────────────────────────────────────────
	let config = $state<Config>({});
	let loading = $state(true);
	let saving = $state(false);
	let saved = $state(false);
	let error = $state('');

	async function loadConfig() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as Config;
			config = {
				provider: 'anthropic',
				default_tier: 'sonnet',
				effort_level: 'high',
				thinking_mode: 'adaptive',
				experience: 'business',
				memory_extraction: true,
				embedding_provider: 'onnx',
				search_provider: 'tavily',
				...data,
			};
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function saveConfig() {
		saving = true;
		error = '';
		try {
			const { managed: _m, ...payload } = config;
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				const detail = await res.text().catch(() => '');
				error = detail ? `${t('common.save_failed')}: ${detail}` : t('common.save_failed');
				saving = false;
				return;
			}
			saved = true;
			setTimeout(() => (saved = false), 2000);
		} catch {
			error = t('common.save_failed');
		}
		saving = false;
	}

	// ── Secrets / Keys (inline in Provider tab) ────────────────────────────────
	let secretNames = $state<string[]>([]);
	let newKeyName = $state('');
	let newKeyValue = $state('');
	let keysSaving = $state(false);
	let editingSecret = $state<string | null>(null);
	let editSecretValue = $state('');
	let editSecretSaving = $state(false);

	const providerKeyDefaults: Record<string, string> = {
		anthropic: 'ANTHROPIC_API_KEY',
		vertex: 'ANTHROPIC_API_KEY',
		custom: 'ANTHROPIC_API_KEY',
		openai: 'OPENAI_API_KEY',
	};

	async function loadSecrets() {
		try {
			const res = await fetch(`${getApiBase()}/secrets`);
			if (!res.ok) return;
			const data = (await res.json()) as { names: string[] };
			secretNames = data.names;
		} catch { /* ignore */ }
	}

	async function saveSecret() {
		if (!newKeyValue.trim()) return;
		keysSaving = true;
		try {
			const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(newKeyName)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: newKeyValue })
			});
			if (!res.ok) throw new Error();
			newKeyValue = '';
			clearError();
			await loadSecrets();
		} catch {
			error = t('common.save_failed');
		}
		keysSaving = false;
	}

	function startEditSecret(name: string) {
		editingSecret = name;
		editSecretValue = '';
	}

	function cancelEditSecret() {
		editingSecret = null;
		editSecretValue = '';
	}

	async function commitEditSecret(name: string) {
		if (!editSecretValue.trim()) return;
		editSecretSaving = true;
		try {
			const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: editSecretValue })
			});
			if (!res.ok) throw new Error();
			clearError();
			editingSecret = null;
			editSecretValue = '';
		} catch {
			error = t('common.save_failed');
		}
		editSecretSaving = false;
	}

	function onEditKeydown(e: KeyboardEvent, name: string) {
		if (e.key === 'Enter' && editSecretValue.trim()) commitEditSecret(name);
		if (e.key === 'Escape') cancelEditSecret();
	}

	async function deleteSecret(name: string) {
		try {
			const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			if (editingSecret === name) cancelEditSecret();
			await loadSecrets();
		} catch {
			error = t('common.save_failed');
		}
	}

	// ── Vault key ──────────────────────────────────────────────────────────────
	let vaultKey = $state<string | null>(null);
	let vaultConfigured = $state(false);
	let vaultRevealed = $state(false);
	let vaultCopied = $state(false);

	async function loadVaultKey() {
		try {
			const res = await fetch(`${getApiBase()}/vault/key?reveal=true`);
			if (!res.ok) return;
			const data = (await res.json()) as { configured: boolean; key?: string };
			vaultConfigured = data.configured;
			vaultKey = data.key ?? null;
		} catch { /* ignore */ }
	}

	function maskKey(key: string): string {
		if (key.length <= 8) return '••••••••';
		return key.slice(0, 4) + '••••••••' + key.slice(-4);
	}

	async function copyVaultKey() {
		if (!vaultKey) return;
		await navigator.clipboard.writeText(vaultKey);
		vaultCopied = true;
		addToast(t('config.vault_key_copied'), 'success');
		setTimeout(() => (vaultCopied = false), 2000);
	}

	// Vault key rotation
	let showRotateModal = $state(false);
	let rotateNewKey = $state<string | null>(null);
	let rotateRevealed = $state(false);
	let rotateCopied = $state(false);
	let rotateConfirmed = $state(false);
	let rotating = $state(false);
	let rotateResult = $state<{ rotated: number; message: string } | null>(null);

	function generateVaultKey(): string {
		const bytes = new Uint8Array(48);
		crypto.getRandomValues(bytes);
		let binary = '';
		for (const b of bytes) binary += String.fromCharCode(b);
		return btoa(binary);
	}

	function startRotation() {
		rotateNewKey = generateVaultKey();
		rotateRevealed = false;
		rotateCopied = false;
		rotateConfirmed = false;
		rotating = false;
		rotateResult = null;
		showRotateModal = true;
	}

	async function copyRotateKey() {
		if (!rotateNewKey) return;
		await navigator.clipboard.writeText(rotateNewKey);
		rotateCopied = true;
		setTimeout(() => (rotateCopied = false), 2000);
	}

	async function executeRotation() {
		if (!rotateNewKey) return;
		rotating = true;
		try {
			const res = await fetch(`${getApiBase()}/vault/rotate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ newKey: rotateNewKey }),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				addToast(text || t('common.save_failed'), 'error');
				rotating = false;
				return;
			}
			const data = (await res.json()) as { rotated: number; message: string };
			rotateResult = data;
			vaultKey = rotateNewKey;
			vaultRevealed = false;
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		rotating = false;
	}

	function closeRotateModal() {
		showRotateModal = false;
		rotateNewKey = null;
		rotateResult = null;
	}

	// ── Access token ───────────────────────────────────────────────────────────
	let accessToken = $state<string | null>(null);
	let accessTokenConfigured = $state(false);
	let accessTokenRevealed = $state(false);
	let accessTokenCopied = $state(false);

	async function loadAccessToken() {
		try {
			const res = await fetch(`${getApiBase()}/auth/token?reveal=true`);
			if (!res.ok) return;
			const data = (await res.json()) as { configured: boolean; token?: string };
			accessTokenConfigured = data.configured;
			accessToken = data.token ?? null;
		} catch { /* ignore */ }
	}

	async function copyAccessToken() {
		if (!accessToken) return;
		await navigator.clipboard.writeText(accessToken);
		accessTokenCopied = true;
		addToast(t('config.access_token_copied'), 'success');
		setTimeout(() => (accessTokenCopied = false), 2000);
	}

	// ── Bugsink ────────────────────────────────────────────────────────────────
	let bugsinkEnabled = $state(false);

	async function loadBugsinkStatus() {
		try {
			const res = await fetch(`${getApiBase()}/secrets/status`);
			const data = (await res.json()) as { configured: { bugsink: boolean } };
			bugsinkEnabled = data.configured.bugsink;
		} catch { /* ignore */ }
	}

	async function toggleBugsink() {
		if (bugsinkEnabled) {
			await fetch(`${getApiBase()}/secrets/LYNOX_BUGSINK_DSN`, { method: 'DELETE' });
			bugsinkEnabled = false;
			addToast(t('config.bugsink_disabled'), 'info');
		} else {
			addToast(t('config.bugsink_disabled'), 'info');
		}
	}

	// ── Version check ──────────────────────────────────────────────────────────
	let currentVersion = $state('');
	let latestVersion = $state<string | null>(null);
	let versionChecking = $state(false);

	async function loadCurrentVersion() {
		try {
			const res = await fetch(`${getApiBase()}/health`);
			const data = (await res.json()) as { version?: string };
			currentVersion = data.version ?? '';
		} catch { /* ignore */ }
	}

	async function checkForUpdates() {
		versionChecking = true;
		try {
			const res = await fetch('https://registry.npmjs.org/@lynox-ai/core/latest');
			const data = (await res.json()) as { version?: string };
			latestVersion = data.version ?? null;
		} catch {
			latestVersion = null;
		}
		versionChecking = false;
	}

	const isUpToDate = $derived(latestVersion && currentVersion && latestVersion === currentVersion);

	// ── Tab state ──────────────────────────────────────────────────────────────
	type Tab = 'ai' | 'provider' | 'compliance' | 'budget' | 'system';

	function getInitialTab(): Tab {
		if (typeof window === 'undefined') return 'ai';
		const params = new URLSearchParams(window.location.search);
		const tab = params.get('tab');
		if (tab === 'provider' || tab === 'compliance' || tab === 'budget' || tab === 'system') return tab;
		return 'ai';
	}

	let activeTab = $state<Tab>(getInitialTab());

	function setTab(tab: Tab) {
		activeTab = tab;
		const url = new URL(window.location.href);
		if (tab === 'ai') url.searchParams.delete('tab');
		else url.searchParams.set('tab', tab);
		history.replaceState({}, '', url.toString());
	}

	// ── Derived state ──────────────────────────────────────────────────────────
	const managed = $derived(!!config.managed);
	// Any managed tier where lynox provides the LLM (Managed / Managed Pro / legacy 'eu').
	// Excludes 'starter' (Hosted/BYOK) where the customer brings their own key.
	const isManagedTier = $derived(
		config.managed === 'managed' || config.managed === 'managed_pro' || config.managed === 'eu'
	);
	const isManagedEu = $derived(isManagedTier); // legacy alias used elsewhere in this view
	const isAnthropicDirect = $derived(config.provider === 'anthropic' || !config.provider);
	const isNonDirect = $derived(config.provider === 'custom' || config.provider === 'vertex' || config.provider === 'openai');
	const showEffortThinking = $derived(isAnthropicDirect || managed);

	// Update default key name when provider changes
	$effect(() => {
		const defaultKey = providerKeyDefaults[config.provider ?? 'anthropic'] ?? 'ANTHROPIC_API_KEY';
		if (newKeyName === 'ANTHROPIC_API_KEY' || newKeyName === 'OPENAI_API_KEY') {
			newKeyName = defaultKey;
		}
	});

	const tabs = $derived(
		[
			{ id: 'ai' as Tab, label: t('config.tab_ai') },
			{ id: 'provider' as Tab, label: t('config.tab_provider') },
			{ id: 'compliance' as Tab, label: t('config.tab_compliance') },
			...(!isManagedEu ? [{ id: 'budget' as Tab, label: t('config.tab_budget') }] : []),
			{ id: 'system' as Tab, label: t('config.tab_system') },
		]
	);

	// ── Init ───────────────────────────────────────────────────────────────────
	$effect(() => {
		loadConfig();
		loadVaultKey();
		loadAccessToken();
		loadBugsinkStatus();
		loadCurrentVersion();
		loadSecrets();
	});

	const inputClass = 'w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none';
	const cardClass = 'rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4';
	const sectionClass = 'text-xs font-mono uppercase tracking-widest text-text-subtle mt-6 mb-3';
</script>

<div class="p-6 max-w-4xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-4 mt-2">{t('config.title')}</h1>

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else}
		<!-- Tab Bar -->
		<div class="flex gap-1 border-b border-border mb-6">
			{#each tabs as tab}
				<button
					onclick={() => setTab(tab.id)}
					class="px-4 py-2 text-sm transition-colors relative {activeTab === tab.id ? 'text-text font-medium' : 'text-text-muted hover:text-text'}"
				>
					{tab.label}
					{#if activeTab === tab.id}
						<span class="absolute bottom-0 left-0 right-0 h-0.5 bg-accent rounded-full"></span>
					{/if}
				</button>
			{/each}
		</div>

		<!-- ═══════════════════════════════════════════════════════════════════ -->
		<!-- TAB: AI                                                           -->
		<!-- ═══════════════════════════════════════════════════════════════════ -->
		{#if activeTab === 'ai'}
			<div class="space-y-4">
				<div class={cardClass}>
					<label for="model" class="block text-sm font-medium mb-1">{t('config.model')}</label>
					<p class="text-xs text-text-muted mb-2">{t('config.model_desc')}</p>
					<select id="model" bind:value={config.default_tier} class={inputClass} disabled={isManagedEu}>
						<option value="haiku" disabled={isManagedEu}>{t('config.model_haiku')}{isManagedEu ? t('config.model_managed_suffix') : ''}</option>
						<option value="sonnet">{t('config.model_sonnet')}</option>
						<option value="opus" disabled={isManagedEu}>{t('config.model_opus')}{isManagedEu ? t('config.model_managed_suffix') : ''}</option>
					</select>
					{#if isManagedEu}
						<p class="text-xs text-text-muted mt-1">{t('config.managed_eu_model_locked')}</p>
					{/if}
				</div>

				{#if showEffortThinking}
					<div class={cardClass}>
						<label for="effort" class="block text-sm font-medium mb-1">{t('config.effort')}</label>
						<p class="text-xs text-text-muted mb-2">{t('config.effort_desc')}</p>
						<select id="effort" bind:value={config.effort_level} class={inputClass}>
							<option value="low">{t('config.effort_low')}</option>
							<option value="medium">{t('config.effort_medium')}</option>
							<option value="high">{t('config.effort_high')}</option>
							<option value="max">{t('config.effort_max')}</option>
						</select>
					</div>

					<div class={cardClass}>
						<label for="thinking" class="block text-sm font-medium mb-1">{t('config.thinking')}</label>
						<p class="text-xs text-text-muted mb-2">{t('config.thinking_desc')}</p>
						<select id="thinking" bind:value={config.thinking_mode} class={inputClass}>
							<option value="disabled">{t('config.thinking_disabled')}</option>
							<option value="adaptive">{t('config.thinking_adaptive')}</option>
						</select>
					</div>
				{:else}
					<div class="{cardClass} opacity-60">
						<p class="text-sm font-medium mb-1">{t('config.effort')} / {t('config.thinking')}</p>
						<p class="text-xs text-text-muted">{isNonDirect ? t('config.anthropic_only_hint') : ''}</p>
					</div>
				{/if}

				<div class={cardClass}>
					<label for="experience" class="block text-sm font-medium mb-1">{t('config.experience')}</label>
					<p class="text-xs text-text-muted mb-2">{t('config.experience_desc')}</p>
					<select id="experience" bind:value={config.experience} class={inputClass}>
						<option value="business">{t('config.experience_business')}</option>
						<option value="developer">{t('config.experience_developer')}</option>
					</select>
				</div>

				<div class="{cardClass} flex items-center justify-between">
					<div>
						<p class="text-sm font-medium">{t('config.memory_extraction')}</p>
						<p class="text-xs text-text-muted mt-1">{t('config.memory_extraction_desc')}</p>
					</div>
					<button onclick={() => config.memory_extraction = !config.memory_extraction} class="relative w-10 h-6 rounded-full transition-colors shrink-0 {config.memory_extraction ? 'bg-accent' : 'bg-border'}" aria-label="Toggle"><span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform {config.memory_extraction ? 'translate-x-4' : ''}"></span></button>
				</div>
			</div>

		<!-- ═══════════════════════════════════════════════════════════════════ -->
		<!-- TAB: Provider                                                     -->
		<!-- ═══════════════════════════════════════════════════════════════════ -->
		{:else if activeTab === 'provider'}
			<div class="space-y-4">
				{#if isManagedTier}
					<div class={cardClass}>
						<p class="text-sm font-medium">{t('config.provider')}</p>
						<p class="text-xs text-text-muted mt-1">{t('config.managed_eu_provider_info')}</p>
						<p class="text-xs text-text-muted mt-2">→ <button type="button" onclick={() => setTab('compliance')} class="text-accent-text hover:underline">{t('config.see_compliance_for_llm_mode')}</button></p>
					</div>
				{:else}
					<div class={cardClass}>
						<label for="provider" class="block text-sm font-medium mb-1">{t('config.provider')}</label>
						<p class="text-xs text-text-muted mb-2">{t('config.provider_desc')}</p>
						<select id="provider" bind:value={config.provider} class={inputClass}>
							<option value="anthropic">{t('config.provider_anthropic')}</option>
							<option value="vertex">{t('config.provider_vertex')}</option>
							<option value="custom">{t('config.provider_custom')}</option>
							<option value="openai">{t('config.provider_openai')}</option>
						</select>
					</div>

					{#if config.provider === 'vertex'}
						<div class={cardClass}>
							<label for="gcp-project" class="block text-sm font-medium mb-1">{t('config.gcp_project_id')}</label>
							<p class="text-xs text-text-muted mb-2">{t('config.gcp_project_id_desc')}</p>
							<input id="gcp-project" type="text" placeholder="lynox-prod"
								bind:value={config.gcp_project_id} class="{inputClass} font-mono" />
						</div>
						<div class={cardClass}>
							<label for="gcp-region" class="block text-sm font-medium mb-2">{t('config.gcp_region')}</label>
							<select id="gcp-region" bind:value={config.gcp_region} class={inputClass}>
								<option value="europe-west4">europe-west4 (Netherlands — EU residency)</option>
								<option value="europe-west1">europe-west1 (Belgium)</option>
								<option value="us-east5">us-east5 (Columbus)</option>
								<option value="us-central1">us-central1 (Iowa)</option>
							</select>
						</div>
						<div class={cardClass}>
							<p class="text-xs text-text-muted">{t('config.credentials_hint_vertex')}</p>
						</div>
					{/if}

					{#if config.provider === 'custom'}
						<div class={cardClass}>
							<label for="custom-url" class="block text-sm font-medium mb-1">{t('config.custom_url')}</label>
							<p class="text-xs text-text-muted mb-2">{t('config.custom_url_desc')}</p>
							<input id="custom-url" type="url" placeholder="http://localhost:4000"
								bind:value={config.api_base_url} class="{inputClass} font-mono" />
						</div>
					{/if}

					{#if config.provider === 'openai'}
						<div class={cardClass}>
							<label for="openai-url" class="block text-sm font-medium mb-1">{t('config.openai_url')}</label>
							<p class="text-xs text-text-muted mb-2">{t('config.openai_url_desc')}</p>
							<input id="openai-url" type="url" placeholder="https://api.mistral.ai/v1"
								bind:value={config.api_base_url} class="{inputClass} font-mono" />
						</div>
					{/if}

					<!-- Inline Key Management -->
					<p class={sectionClass}>{t('keys.title')}</p>

					{#if secretNames.length > 0}
						<div class="space-y-2">
							{#each secretNames as name}
								<div class="{cardClass} !p-3">
									<div class="flex items-center justify-between">
										<span class="font-mono text-sm">{name}</span>
										<div class="flex items-center gap-2">
											{#if editingSecret !== name}
												<button onclick={() => startEditSecret(name)} class="text-xs text-accent-text hover:underline">{t('keys.edit')}</button>
											{/if}
											<button onclick={() => deleteSecret(name)} class="text-xs text-danger hover:underline">{t('settings.delete')}</button>
										</div>
									</div>
									{#if editingSecret === name}
										<div class="flex items-center gap-2 mt-2">
											<input
												type="password"
												bind:value={editSecretValue}
												onkeydown={(e) => onEditKeydown(e, name)}
												placeholder={t('keys.new_value')}
												autocomplete="off"
												class="flex-1 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-1.5 font-mono text-sm focus:border-accent focus:outline-none"
											/>
											<button onclick={() => commitEditSecret(name)} disabled={editSecretSaving || !editSecretValue.trim()} class="rounded-[var(--radius-sm)] bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50">
												{editSecretSaving ? t('settings.saving') : t('settings.save')}
											</button>
											<button onclick={cancelEditSecret} class="text-xs text-text-subtle hover:text-text">{t('common.cancel')}</button>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{:else}
						<p class="text-text-subtle text-sm">{t('keys.no_keys')}</p>
					{/if}

					<div class="{cardClass} space-y-3">
						<h3 class="text-sm font-medium">{t('keys.add_title')}</h3>
						<div>
							<label for="key-name" class="block text-xs text-text-muted">{t('keys.name_label')}</label>
							<input id="key-name" bind:value={newKeyName} class="mt-1 {inputClass} font-mono" />
						</div>
						<div>
							<label for="key-value" class="block text-xs text-text-muted">{t('keys.value_label')}</label>
							<input id="key-value" bind:value={newKeyValue} type="password" placeholder="sk-ant-..."
								class="mt-1 {inputClass} font-mono" />
						</div>
						<button onclick={saveSecret} disabled={keysSaving || !newKeyValue.trim()}
							class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90 disabled:opacity-50">
							{keysSaving ? t('settings.saving') : t('settings.save')}
						</button>
					</div>
				{/if}
			</div>

		<!-- ═══════════════════════════════════════════════════════════════════ -->
		<!-- TAB: Compliance & Privacy                                        -->
		<!-- Phase 0 skeleton — see pro/docs/internal/prd/settings-compliance-overhaul.md -->
		<!-- Today's gating rules preserved. Capability-based gating = Phase 1. -->
		<!-- ═══════════════════════════════════════════════════════════════════ -->
		{:else if activeTab === 'compliance'}
			<div class="space-y-4">
				<p class="text-xs text-text-muted">{t('config.compliance_intro')}</p>

				<!-- ── Data Residency Panel (read-only, always visible) ───────── -->
				<p class={sectionClass}>{t('config.residency_title')}</p>
				<div class={cardClass}>
					<dl class="space-y-2 text-sm">
						<div class="flex items-start justify-between gap-4">
							<dt class="text-text-muted shrink-0">{t('config.residency_llm')}</dt>
							<dd class="text-right">
								{#if isManagedTier && config.llm_mode === 'eu-sovereign'}
									Mistral — Paris (EU)
								{:else if isManagedTier}
									Anthropic — US (DPA + GDPR)
								{:else if config.provider === 'anthropic' || !config.provider}
									Anthropic — US (DPA + GDPR)
								{:else if config.provider === 'vertex'}
									Google Vertex — {config.gcp_region ?? '—'}
								{:else if config.provider === 'openai'}
									{config.api_base_url ?? 'custom endpoint'}
								{:else}
									{config.api_base_url ?? '—'}
								{/if}
							</dd>
						</div>
						<div class="flex items-start justify-between gap-4">
							<dt class="text-text-muted shrink-0">{t('config.residency_voice_in')}</dt>
							<dd class="text-right text-text-muted">{t('config.residency_voice_in_value')}</dd>
						</div>
						<div class="flex items-start justify-between gap-4">
							<dt class="text-text-muted shrink-0">{t('config.residency_voice_out')}</dt>
							<dd class="text-right text-text-muted">{t('config.residency_voice_out_value')}</dd>
						</div>
						<div class="flex items-start justify-between gap-4">
							<dt class="text-text-muted shrink-0">{t('config.residency_storage')}</dt>
							<dd class="text-right text-text-muted">
								{#if isManagedTier}
									Hetzner — Germany
								{:else}
									{t('config.residency_storage_local')}
								{/if}
							</dd>
						</div>
					</dl>
				</div>

				<!-- ── LLM Mode (moved from Provider tab) ─────────────────────── -->
				{#if isManagedTier}
					<p class={sectionClass}>{t('config.llm_mode')}</p>
					<div class={cardClass}>
						<p class="text-xs text-text-muted mb-3">{t('config.llm_mode_desc')}</p>

						<label class="flex items-start gap-3 p-3 rounded-[var(--radius-md)] border border-border bg-bg cursor-pointer hover:border-accent transition-colors mb-2">
							<input
								type="radio"
								name="llm-mode"
								value="standard"
								checked={(config.llm_mode ?? 'standard') === 'standard'}
								onchange={() => { config.llm_mode = 'standard'; }}
								class="mt-1 accent-accent shrink-0"
							/>
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium">{t('config.llm_mode_standard')}</p>
								<p class="text-xs text-text-muted mt-0.5">{t('config.llm_mode_standard_desc')}</p>
							</div>
						</label>

						<label class="flex items-start gap-3 p-3 rounded-[var(--radius-md)] border border-border bg-bg cursor-pointer hover:border-accent transition-colors">
							<input
								type="radio"
								name="llm-mode"
								value="eu-sovereign"
								checked={config.llm_mode === 'eu-sovereign'}
								onchange={() => { config.llm_mode = 'eu-sovereign'; }}
								class="mt-1 accent-accent shrink-0"
							/>
							<div class="flex-1 min-w-0">
								<p class="text-sm font-medium">{t('config.llm_mode_eu_sovereign')}</p>
								<p class="text-xs text-text-muted mt-0.5">{t('config.llm_mode_eu_sovereign_desc')}</p>
							</div>
						</label>

						<p class="text-xs text-text-muted mt-3 italic">{t('config.llm_mode_restart_required')}</p>
					</div>
				{/if}

				<!-- ── Voice (Phase 2 placeholder) ────────────────────────────── -->
				<p class={sectionClass}>{t('config.voice_title')}</p>
				<div class={cardClass}>
					<p class="text-sm font-medium mb-1">{t('config.voice_stt_label')}</p>
					<p class="text-xs text-text-muted mb-2">{t('config.voice_stt_current_env')}</p>
					<p class="text-xs text-text-muted italic">{t('config.voice_picker_coming')}</p>
				</div>
				<div class={cardClass}>
					<p class="text-sm font-medium mb-1">{t('config.voice_tts_label')}</p>
					<p class="text-xs text-text-muted mb-2">{t('config.voice_tts_current_default')}</p>
					<p class="text-xs text-text-muted italic">{t('config.voice_picker_coming')}</p>
				</div>

				<!-- ── Error Reporting (Phase 4 — will move here from System) ── -->
				<p class={sectionClass}>{t('config.error_reporting_title')}</p>
				<div class={cardClass}>
					<p class="text-xs text-text-muted italic">{t('config.error_reporting_moving_soon')}</p>
				</div>
			</div>

		<!-- ═══════════════════════════════════════════════════════════════════ -->
		<!-- TAB: Budget                                                       -->
		<!-- ═══════════════════════════════════════════════════════════════════ -->
		{:else if activeTab === 'budget'}
			<div class="space-y-4">
				<div class={cardClass}>
					<label for="monthly-limit" class="block text-sm font-medium mb-1">{t('config.monthly_limit')}</label>
					<p class="text-xs text-text-muted mb-2">{t('config.monthly_limit_desc')}</p>
					<input id="monthly-limit" type="number" step="1" min="0" placeholder="—"
						bind:value={config.max_monthly_cost_usd} class="{inputClass} font-mono" />
				</div>

				{#if !managed}
					<div class={cardClass}>
						<label for="daily-limit" class="block text-sm font-medium mb-1">{t('config.daily_limit')}</label>
						<p class="text-xs text-text-muted mb-2">{t('config.daily_limit_desc')}</p>
						<input id="daily-limit" type="number" step="0.5" min="0" placeholder="—"
							bind:value={config.max_daily_cost_usd} class="{inputClass} font-mono" />
					</div>

					<div class={cardClass}>
						<label for="session-limit" class="block text-sm font-medium mb-1">{t('config.session_limit')}</label>
						<p class="text-xs text-text-muted mb-2">{t('config.session_limit_desc')}</p>
						<input id="session-limit" type="number" step="0.5" min="0" placeholder="5.00"
							bind:value={config.max_session_cost_usd} class="{inputClass} font-mono" />
					</div>
				{/if}
			</div>

		<!-- ═══════════════════════════════════════════════════════════════════ -->
		<!-- TAB: System                                                       -->
		<!-- ═══════════════════════════════════════════════════════════════════ -->
		{:else if activeTab === 'system'}
			<div class="space-y-4">
				<!-- Knowledge -->
				<div class={cardClass}>
					<label for="half-life" class="block text-sm font-medium mb-1">{t('config.memory_half_life')}</label>
					<p class="text-xs text-text-muted mb-2">{t('config.memory_half_life_desc')}</p>
					<input id="half-life" type="number" min="1" placeholder="90"
						bind:value={config.memory_half_life_days} class="{inputClass} font-mono" />
				</div>

				{#if !managed}
					<div class={cardClass}>
						<label for="embedding" class="block text-sm font-medium mb-2">{t('config.embedding_provider')}</label>
						<select id="embedding" bind:value={config.embedding_provider} class={inputClass}>
							<option value="onnx">{t('config.embedding_onnx')}</option>
						</select>
					</div>

					<!-- Limits -->
					<p class={sectionClass}>{t('config.limits')}</p>

					<div class={cardClass}>
						<label for="http-rate" class="block text-sm font-medium mb-1">{t('config.http_rate_limit')}</label>
						<p class="text-xs text-text-muted mb-2">{t('config.http_rate_limit_desc')}</p>
						<input id="http-rate" type="number" min="1" placeholder="—"
							bind:value={config.max_http_requests_per_hour} class="{inputClass} font-mono" />
					</div>

					<!-- Security -->
					<p class={sectionClass}>{t('config.security')}</p>

					<div class={cardClass}>
						<p class="text-sm font-medium mb-1">{t('config.vault_key')}</p>
						<p class="text-xs text-text-muted mb-3">{t('config.vault_key_desc')}</p>
						{#if vaultConfigured && vaultKey}
							<div class="flex items-center gap-2 mb-2">
								<code class="flex-1 rounded-[var(--radius-sm)] bg-bg px-3 py-2 text-sm font-mono select-all break-all">
									{vaultRevealed ? vaultKey : maskKey(vaultKey)}
								</code>
								<button onclick={() => (vaultRevealed = !vaultRevealed)} class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0">
									{vaultRevealed ? t('config.hide') : t('config.reveal')}
								</button>
								<button onclick={copyVaultKey} class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0 {vaultCopied ? 'text-success border-success/30' : ''}">
									{t('config.copy')}
								</button>
							</div>
							<p class="text-xs text-warning/80">{t('config.vault_key_warning')}</p>
							<div class="mt-3 pt-3 border-t border-border/50">
								<button onclick={startRotation} class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all">
									{t('config.vault_rotate')}
								</button>
							</div>
						{:else}
							<p class="text-xs text-text-muted">{t('config.vault_key_not_configured')}</p>
						{/if}
					</div>

					<div class={cardClass}>
						<p class="text-sm font-medium mb-1">{t('config.access_token')}</p>
						<p class="text-xs text-text-muted mb-3">{t('config.access_token_desc')}</p>
						{#if accessTokenConfigured && accessToken}
							<div class="flex items-center gap-2">
								<code class="flex-1 rounded-[var(--radius-sm)] bg-bg px-3 py-2 text-sm font-mono select-all break-all">
									{accessTokenRevealed ? accessToken : maskKey(accessToken)}
								</code>
								<button onclick={() => (accessTokenRevealed = !accessTokenRevealed)} class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0">
									{accessTokenRevealed ? t('config.hide') : t('config.reveal')}
								</button>
								<button onclick={copyAccessToken} class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0 {accessTokenCopied ? 'text-success border-success/30' : ''}">
									{t('config.copy')}
								</button>
							</div>
						{:else}
							<p class="text-xs text-text-muted">{t('config.access_token_not_configured')}</p>
						{/if}
					</div>

					<!-- Privacy -->
					<p class={sectionClass}>{t('config.privacy')}</p>

					<div class="{cardClass} flex items-center justify-between">
						<div>
							<p class="text-sm font-medium">{t('config.bugsink')}</p>
							<p class="text-xs text-text-muted mt-1">{t('config.bugsink_desc')}</p>
						</div>
						<button onclick={toggleBugsink} class="relative w-10 h-6 rounded-full transition-colors shrink-0 {bugsinkEnabled ? 'bg-accent' : 'bg-border'}" aria-label="Toggle"><span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform {bugsinkEnabled ? 'translate-x-4' : ''}"></span></button>
					</div>
				{:else}
					<p class={sectionClass}>{t('config.security')}</p>
					<div class={cardClass}>
						<p class="text-sm font-medium">{t('config.security')}</p>
						<p class="text-xs text-text-muted mt-1">{t('config.managed_security_info')}</p>
					</div>
				{/if}

				<!-- Updates -->
				<p class={sectionClass}>{t('config.updates')}</p>

				{#if !managed}
					<div class="{cardClass} flex items-center justify-between">
						<div>
							<p class="text-sm font-medium">{t('config.update_check')}</p>
							<p class="text-xs text-text-muted mt-1">{t('config.update_check_desc')}</p>
						</div>
						<button onclick={() => config.update_check = !config.update_check} class="relative w-10 h-6 rounded-full transition-colors shrink-0 {config.update_check ? 'bg-accent' : 'bg-border'}" aria-label="Toggle"><span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform {config.update_check ? 'translate-x-4' : ''}"></span></button>
					</div>
				{/if}

				<div class={cardClass}>
					<div class="flex items-center justify-between">
						<div class="space-y-1">
							{#if currentVersion}
								<p class="text-xs text-text-muted">{t('config.version_current')}: <span class="font-mono text-text">{currentVersion}</span></p>
							{/if}
							{#if latestVersion}
								<p class="text-xs text-text-muted">{t('config.version_latest')}: <span class="font-mono {isUpToDate ? 'text-success' : 'text-warning'}">{latestVersion}</span>
									{#if isUpToDate}
										<span class="text-success ml-1">{t('config.version_up_to_date')}</span>
									{:else}
										<span class="text-warning ml-1">{t('config.version_update_available')}</span>
									{/if}
								</p>
							{/if}
						</div>
						{#if !managed}
							<button
								onclick={checkForUpdates}
								disabled={versionChecking}
								class="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all disabled:opacity-50"
							>
								{versionChecking ? t('config.version_checking') : t('config.check_now')}
							</button>
						{/if}
					</div>
					{#if managed}
						<p class="text-xs text-text-muted mt-2">{t('config.managed_updates_info')}</p>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Error + Save (always visible) -->
		{#if error}
			<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mt-4">{error}</div>
		{/if}

		<div class="flex items-center gap-3 pt-4">
			<button
				onclick={saveConfig}
				disabled={saving}
				class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90 disabled:opacity-50"
			>
				{saving ? t('settings.saving') : t('settings.save')}
			</button>
			{#if saved}
				<span class="text-sm text-success">{t('settings.saved')}</span>
			{/if}
		</div>
	{/if}
</div>

{#if showRotateModal}
	<div class="fixed inset-0 z-[9998] bg-black/60 flex items-center justify-center" role="dialog" aria-modal="true" tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget && rotateResult) closeRotateModal(); }}
		onkeydown={(e) => { if (e.key === 'Escape' && rotateResult) closeRotateModal(); }}
	>
		<div class="bg-bg border border-border rounded-[var(--radius-md)] p-6 max-w-md mx-4 space-y-4">
			{#if rotateResult}
				<div>
					<h2 class="text-base font-medium text-success">{t('config.vault_rotated_title')}</h2>
					<p class="text-xs text-text-muted mt-1">{t('config.vault_rotated_desc')}</p>
				</div>
				<div class="rounded-[var(--radius-sm)] bg-warning/10 border border-warning/20 px-3 py-2 text-xs text-warning">
					{t('config.vault_rotated_env_warning')}
				</div>
				<p class="text-xs text-text-muted font-mono">{rotateResult.rotated} {t('config.vault_rotated_count')}</p>
				<button onclick={closeRotateModal} class="w-full rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90">OK</button>
			{:else}
				<div>
					<h2 class="text-base font-medium text-text">{t('config.vault_rotate_title')}</h2>
					<p class="text-xs text-text-muted mt-1">{t('config.vault_rotate_desc')}</p>
				</div>
				<div class="flex items-center gap-2">
					<code class="flex-1 rounded-[var(--radius-sm)] bg-bg-subtle px-3 py-2 text-sm font-mono select-all break-all">
						{rotateRevealed ? rotateNewKey : maskKey(rotateNewKey ?? '')}
					</code>
					<button onclick={() => (rotateRevealed = !rotateRevealed)} class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0">
						{rotateRevealed ? t('config.hide') : t('config.reveal')}
					</button>
					<button onclick={copyRotateKey} class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0 {rotateCopied ? 'text-success border-success/30' : ''}">
						{t('config.copy')}
					</button>
				</div>
				<p class="text-xs text-warning/80">{t('config.vault_key_warning')}</p>
				<label class="flex items-center gap-2 text-xs text-text-muted cursor-pointer">
					<input type="checkbox" bind:checked={rotateConfirmed} class="rounded border-border" />
					{t('config.vault_rotate_confirm')}
				</label>
				<div class="flex gap-3 justify-end">
					<button onclick={closeRotateModal} class="text-xs text-text-muted hover:text-text px-3 py-1.5">{t('common.cancel')}</button>
					<button onclick={executeRotation} disabled={!rotateConfirmed || rotating} class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90 disabled:opacity-50">
						{rotating ? t('config.vault_rotating') : t('config.vault_rotate')}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
