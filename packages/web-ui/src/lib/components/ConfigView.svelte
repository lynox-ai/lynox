<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	const SENTRY_DSN = 'https://21110d12849ca21ae1309b661ab3b603@o4511106815492096.ingest.de.sentry.io/4511106856976464';

	interface Config {
		provider?: string;
		aws_region?: string;
		bedrock_eu_only?: boolean;
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
		[key: string]: unknown;
	}

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
			// Apply defaults for undefined fields (Engine defaults: sonnet, high, adaptive)
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
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(config)
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

	// Sentry opt-in
	// Vault key
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
		} catch { /* ignore — endpoint may not exist on older engines */ }
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

	let sentryEnabled = $state(false);

	async function loadSentryStatus() {
		try {
			const res = await fetch(`${getApiBase()}/secrets/status`);
			const data = (await res.json()) as { configured: { sentry: boolean } };
			sentryEnabled = data.configured.sentry;
		} catch { /* ignore */ }
	}

	async function toggleSentry() {
		if (sentryEnabled) {
			await fetch(`${getApiBase()}/secrets/LYNOX_SENTRY_DSN`, { method: 'DELETE' });
			sentryEnabled = false;
			addToast(t('config.sentry_disabled'), 'info');
		} else {
			await fetch(`${getApiBase()}/secrets/LYNOX_SENTRY_DSN`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: SENTRY_DSN })
			});
			sentryEnabled = true;
			addToast(t('config.sentry_enabled'), 'success');
		}
	}

	// Version check
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

	$effect(() => {
		loadConfig();
		loadVaultKey();
		loadSentryStatus();
		loadCurrentVersion();
	});

	const inputClass = 'w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none';
	const cardClass = 'rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4';
	const sectionClass = 'text-xs font-mono uppercase tracking-widest text-text-subtle mt-8 mb-3';
</script>

<div class="p-6 max-w-4xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-4 mt-2">{t('config.title')}</h1>

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else}
		<div class="space-y-4">
			<!-- LLM Provider -->
			<div class={cardClass}>
				<label for="provider" class="block text-sm font-medium mb-1">{t('config.provider')}</label>
				<p class="text-xs text-text-muted mb-2">{t('config.provider_desc')}</p>
				<select id="provider" bind:value={config.provider} class={inputClass}>
					<option value="anthropic">{t('config.provider_anthropic')}</option>
					<option value="bedrock">{t('config.provider_bedrock')} (experimental)</option>
					<option value="vertex">{t('config.provider_vertex')} (experimental)</option>
					<option value="custom">{t('config.provider_custom')} (experimental)</option>
				</select>
			</div>

			{#if config.provider === 'bedrock'}
				<div class={cardClass}>
					<label for="aws-region" class="block text-sm font-medium mb-2">{t('config.aws_region')}</label>
					<select id="aws-region" bind:value={config.aws_region} class={inputClass}>
						<option value="eu-central-1">eu-central-1 (Frankfurt)</option>
						<option value="eu-central-2">eu-central-2 (Zurich)</option>
						<option value="eu-west-1">eu-west-1 (Ireland)</option>
						<option value="eu-west-3">eu-west-3 (Paris)</option>
						<option value="eu-north-1">eu-north-1 (Stockholm)</option>
						<option value="eu-south-1">eu-south-1 (Milan)</option>
						<option value="us-east-1">us-east-1 (N. Virginia)</option>
						<option value="us-west-2">us-west-2 (Oregon)</option>
					</select>
				</div>
				<div class="{cardClass} flex items-center justify-between">
					<div>
						<p class="text-sm font-medium">{t('config.bedrock_eu_only')}</p>
						<p class="text-xs text-text-muted mt-1">{t('config.bedrock_eu_only_desc')}</p>
					</div>
					<button onclick={() => config.bedrock_eu_only = !config.bedrock_eu_only} class="relative w-10 h-6 rounded-full transition-colors shrink-0 {config.bedrock_eu_only ? 'bg-accent' : 'bg-border'}" aria-label="Toggle"><span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform {config.bedrock_eu_only ? 'translate-x-4' : ''}"></span></button>
				</div>
			{/if}

			{#if config.provider === 'vertex'}
				<div class={cardClass}>
					<label for="gcp-region" class="block text-sm font-medium mb-2">{t('config.gcp_region')}</label>
					<select id="gcp-region" bind:value={config.gcp_region} class={inputClass}>
						<option value="europe-west1">europe-west1 (Belgium)</option>
						<option value="us-east5">us-east5 (Columbus)</option>
						<option value="us-central1">us-central1 (Iowa)</option>
					</select>
				</div>
				<div class={cardClass}>
					<label for="gcp-project" class="block text-sm font-medium mb-2">{t('config.gcp_project_id')}</label>
					<input id="gcp-project" type="text" placeholder="my-project-123"
						bind:value={config.gcp_project_id} class="{inputClass} font-mono" />
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

			<!-- Model & Inference -->
			<p class={sectionClass}>{t('config.model')}</p>

			<div class={cardClass}>
				<label for="model" class="block text-sm font-medium mb-2">{t('config.model')}</label>
				<select id="model" bind:value={config.default_tier} class={inputClass}>
					<option value="haiku">{t('config.model_haiku')}</option>
					<option value="sonnet">{t('config.model_sonnet')}</option>
					<option value="opus">{t('config.model_opus')}</option>
				</select>
			</div>

			<div class={cardClass}>
				<label for="effort" class="block text-sm font-medium mb-2">{t('config.effort')}</label>
				<select id="effort" bind:value={config.effort_level} class={inputClass}>
					<option value="low">{t('config.effort_low')}</option>
					<option value="medium">{t('config.effort_medium')}</option>
					<option value="high">{t('config.effort_high')}</option>
					<option value="max">{t('config.effort_max')}</option>
				</select>
			</div>

			<div class={cardClass}>
				<label for="thinking" class="block text-sm font-medium mb-2">{t('config.thinking')}</label>
				<select id="thinking" bind:value={config.thinking_mode} class={inputClass}>
					<option value="disabled">{t('config.thinking_disabled')}</option>
					<option value="adaptive">{t('config.thinking_adaptive')}</option>
				</select>
			</div>

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

			<!-- Budget -->
			<p class={sectionClass}>{t('config.budget')}</p>

			<div class={cardClass}>
				<label for="session-limit" class="block text-sm font-medium mb-1">{t('config.session_limit')}</label>
				<p class="text-xs text-text-muted mb-2">{t('config.session_limit_desc')}</p>
				<input id="session-limit" type="number" step="0.5" min="0" placeholder="5.00"
					bind:value={config.max_session_cost_usd} class="{inputClass} font-mono" />
			</div>

			<div class={cardClass}>
				<label for="daily-limit" class="block text-sm font-medium mb-1">{t('config.daily_limit')}</label>
				<p class="text-xs text-text-muted mb-2">{t('config.daily_limit_desc')}</p>
				<input id="daily-limit" type="number" step="0.5" min="0" placeholder="—"
					bind:value={config.max_daily_cost_usd} class="{inputClass} font-mono" />
			</div>

			<div class={cardClass}>
				<label for="monthly-limit" class="block text-sm font-medium mb-1">{t('config.monthly_limit')}</label>
				<p class="text-xs text-text-muted mb-2">{t('config.monthly_limit_desc')}</p>
				<input id="monthly-limit" type="number" step="1" min="0" placeholder="—"
					bind:value={config.max_monthly_cost_usd} class="{inputClass} font-mono" />
			</div>

			<!-- Knowledge -->
			<p class={sectionClass}>{t('config.knowledge')}</p>

			<div class={cardClass}>
				<label for="half-life" class="block text-sm font-medium mb-1">{t('config.memory_half_life')}</label>
				<p class="text-xs text-text-muted mb-2">{t('config.memory_half_life_desc')}</p>
				<input id="half-life" type="number" min="1" placeholder="90"
					bind:value={config.memory_half_life_days} class="{inputClass} font-mono" />
			</div>

			<div class={cardClass}>
				<label for="embedding" class="block text-sm font-medium mb-2">{t('config.embedding_provider')}</label>
				<select id="embedding" bind:value={config.embedding_provider} class={inputClass}>
					<option value="onnx">{t('config.embedding_onnx')}</option>
					<option value="voyage">{t('config.embedding_voyage')}</option>
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
						<button
							onclick={() => (vaultRevealed = !vaultRevealed)}
							class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0"
						>
							{vaultRevealed ? t('config.hide') : t('config.reveal')}
						</button>
						<button
							onclick={copyVaultKey}
							class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all shrink-0 {vaultCopied ? 'text-success border-success/30' : ''}"
						>
							{t('config.copy')}
						</button>
					</div>
					<p class="text-xs text-warning/80">{t('config.vault_key_warning')}</p>
				{:else}
					<p class="text-xs text-text-muted">{t('config.vault_key_not_configured')}</p>
				{/if}
			</div>

			<!-- Privacy -->
			<p class={sectionClass}>{t('config.privacy')}</p>

			<div class="{cardClass} flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">{t('config.sentry')}</p>
					<p class="text-xs text-text-muted mt-1">{t('config.sentry_desc')}</p>
				</div>
				<button onclick={toggleSentry} class="relative w-10 h-6 rounded-full transition-colors shrink-0 {sentryEnabled ? 'bg-accent' : 'bg-border'}" aria-label="Toggle"><span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform {sentryEnabled ? 'translate-x-4' : ''}"></span></button>
			</div>

			<!-- Updates -->
			<p class={sectionClass}>{t('config.updates')}</p>

			<div class="{cardClass} flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">{t('config.update_check')}</p>
					<p class="text-xs text-text-muted mt-1">{t('config.update_check_desc')}</p>
				</div>
				<button onclick={() => config.update_check = !config.update_check} class="relative w-10 h-6 rounded-full transition-colors shrink-0 {config.update_check ? 'bg-accent' : 'bg-border'}" aria-label="Toggle"><span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform {config.update_check ? 'translate-x-4' : ''}"></span></button>
			</div>

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
					<button
						onclick={checkForUpdates}
						disabled={versionChecking}
						class="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all disabled:opacity-50"
					>
						{versionChecking ? t('config.version_checking') : t('config.check_now')}
					</button>
				</div>
			</div>

			<!-- Error + Save -->
			{#if error}
				<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">{error}</div>
			{/if}

			<div class="flex items-center gap-3 pt-2">
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
		</div>
	{/if}
</div>
