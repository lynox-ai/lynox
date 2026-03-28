<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	const SENTRY_DSN = 'https://21110d12849ca21ae1309b661ab3b603@o4511106815492096.ingest.de.sentry.io/4511106856976464';

	interface Config {
		default_tier?: string;
		effort_level?: string;
		thinking_mode?: string;
		memory_extraction?: boolean;
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
				default_tier: 'sonnet',
				effort_level: 'high',
				thinking_mode: 'adaptive',
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
			if (!res.ok) throw new Error();
			saved = true;
			setTimeout(() => (saved = false), 2000);
		} catch {
			error = t('common.save_failed');
		}
		saving = false;
	}

	// Sentry opt-in
	let sentryEnabled = $state(false);

	async function loadSentryStatus() {
		try {
			const res = await fetch(`${getApiBase()}/secrets`);
			const data = (await res.json()) as { names: string[] };
			sentryEnabled = data.names.includes('LYNOX_SENTRY_DSN');
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
			<!-- Model & Inference -->
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
				</select>
			</div>

			<div class={cardClass}>
				<label for="thinking" class="block text-sm font-medium mb-2">{t('config.thinking')}</label>
				<select id="thinking" bind:value={config.thinking_mode} class={inputClass}>
					<option value="disabled">{t('config.thinking_disabled')}</option>
					<option value="adaptive">{t('config.thinking_adaptive')}</option>
				</select>
			</div>

			<div class="{cardClass} flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">{t('config.memory_extraction')}</p>
					<p class="text-xs text-text-muted mt-1">{t('config.memory_extraction_desc')}</p>
				</div>
				<input type="checkbox" bind:checked={config.memory_extraction} class="h-4 w-4 rounded border-border accent-accent" />
			</div>

			<!-- Budget -->
			<p class={sectionClass}>{t('config.budget')}</p>

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

			<!-- Backup -->
			<p class={sectionClass}>{t('config.backup')}</p>

			<div class={cardClass}>
				<label for="backup-schedule" class="block text-sm font-medium mb-1">{t('config.backup_schedule')}</label>
				<p class="text-xs text-text-muted mb-2">{t('config.backup_schedule_desc')}</p>
				<input id="backup-schedule" type="text" placeholder="0 3 * * *"
					bind:value={config.backup_schedule} class="{inputClass} font-mono" />
			</div>

			<div class={cardClass}>
				<label for="backup-retention" class="block text-sm font-medium mb-1">{t('config.backup_retention')}</label>
				<input id="backup-retention" type="number" min="1" placeholder="30"
					bind:value={config.backup_retention_days} class="{inputClass} font-mono" />
			</div>

			<div class="{cardClass} flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">{t('config.backup_encrypt')}</p>
					<p class="text-xs text-text-muted mt-1">{t('config.backup_encrypt_desc')}</p>
				</div>
				<input type="checkbox" bind:checked={config.backup_encrypt} class="h-4 w-4 rounded border-border accent-accent" />
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

			<div class={cardClass}>
				<label for="search-prov" class="block text-sm font-medium mb-2">{t('config.search_provider')}</label>
				<select id="search-prov" bind:value={config.search_provider} class={inputClass}>
					<option value="tavily">Tavily</option>
					<option value="brave">Brave</option>
				</select>
			</div>

			<!-- Privacy -->
			<p class={sectionClass}>{t('config.privacy')}</p>

			<div class="{cardClass} flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">{t('config.sentry')}</p>
					<p class="text-xs text-text-muted mt-1">{t('config.sentry_desc')}</p>
				</div>
				<button
					onclick={toggleSentry}
					class="rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-medium transition-all {sentryEnabled ? 'bg-success/15 border border-success/30 text-success' : 'bg-bg-muted border border-border text-text-muted hover:text-text'}"
				>
					{sentryEnabled ? t('config.sentry_enabled') : t('config.sentry_disabled')}
				</button>
			</div>

			<!-- Updates -->
			<p class={sectionClass}>{t('config.updates')}</p>

			<div class="{cardClass} flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">{t('config.update_check')}</p>
					<p class="text-xs text-text-muted mt-1">{t('config.update_check_desc')}</p>
				</div>
				<input type="checkbox" bind:checked={config.update_check} class="h-4 w-4 rounded border-border accent-accent" />
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
