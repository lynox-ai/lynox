<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	interface Config {
		default_tier?: string;
		effort_level?: string;
		thinking_mode?: string;
		memory_extraction?: boolean;
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
			config = (await res.json()) as Config;
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

	$effect(() => {
		loadConfig();
	});
</script>

<div class="p-6 max-w-4xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-4 mt-2">{t('config.title')}</h1>

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else}
		<div class="space-y-6">
			<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
				<label for="model" class="block text-sm font-medium mb-2">{t('config.model')}</label>
				<select
					id="model"
					bind:value={config.default_tier}
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
				>
					<option value="haiku">{t('config.model_haiku')}</option>
					<option value="sonnet">{t('config.model_sonnet')}</option>
					<option value="opus">{t('config.model_opus')}</option>
				</select>
			</div>

			<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
				<label for="effort" class="block text-sm font-medium mb-2">{t('config.effort')}</label>
				<select
					id="effort"
					bind:value={config.effort_level}
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
				>
					<option value="low">{t('config.effort_low')}</option>
					<option value="medium">{t('config.effort_medium')}</option>
					<option value="high">{t('config.effort_high')}</option>
				</select>
			</div>

			<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
				<label for="thinking" class="block text-sm font-medium mb-2">{t('config.thinking')}</label>
				<select
					id="thinking"
					bind:value={config.thinking_mode}
					class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
				>
					<option value="disabled">{t('config.thinking_disabled')}</option>
					<option value="adaptive">{t('config.thinking_adaptive')}</option>
				</select>
			</div>

			<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 flex items-center justify-between">
				<div>
					<p class="text-sm font-medium">{t('config.memory_extraction')}</p>
					<p class="text-xs text-text-muted mt-1">{t('config.memory_extraction_desc')}</p>
				</div>
				<input
					type="checkbox"
					bind:checked={config.memory_extraction}
					class="h-4 w-4 rounded border-border accent-accent"
				/>
			</div>

			{#if error}
				<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">{error}</div>
			{/if}

			<div class="flex items-center gap-3">
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
