<script lang="ts">
	// === Web Search channel card ===
	//
	// Extracted from IntegrationsView.svelte during PRD-IA-V2 P3-PR-A2.
	// SearXNG is the only surfaced provider: free, self-hosted, no third-party
	// quota. Tavily backend support still exists in the engine for backward-
	// compat with TAVILY_API_KEY env var, but is no longer surfaced in the UI
	// (P3-FOLLOWUP-HOTFIX). Hidden entirely on managed (SearXNG is a
	// pre-configured sidecar there).
	//
	// State lives in `stores/integrations/search.svelte.ts` (P3-PR-A1).

	import { t } from '../i18n.svelte.js';
	import {
		isSecretsLoading,
		isSearxngConfigured,
		getSearxngConfiguredUrl,
		loadSecretStatuses,
	} from '../stores/integrations/secrets.svelte.js';
	import { isManaged, loadManagedStatus } from '../stores/integrations/managed.svelte.js';
	import {
		getSearxngUrl,
		setSearxngUrl,
		isSearxngSaving,
		isSearxngSaved,
		isSearxngChecking,
		getSearxngHealthy,
		checkSearxng,
		saveSearxng,
		removeSearxng,
	} from '../stores/integrations/search.svelte.js';

	$effect(() => {
		void loadManagedStatus();
		void loadSecretStatuses();
	});
</script>

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<a href="/app/settings/channels" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.channels.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-6 mt-2">{t('settings.channels.search')}</h1>

	{#if isManaged()}
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
			<p class="text-sm text-text-muted">{t('integrations.search_managed_hint')}</p>
		</div>
	{:else}
		<!-- SearXNG (free self-hosted primary) -->
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
			<div class="flex items-center justify-between mb-4">
				<div>
					<h2 class="font-medium">{t('integrations.searxng')}</h2>
					<p class="text-xs text-text-muted mt-1">{t('integrations.searxng_desc')}</p>
				</div>
				{#if isSecretsLoading()}
					<span class="text-xs text-text-subtle">{t('common.loading')}</span>
				{:else if isSearxngConfigured()}
					<span class="text-xs text-success">{t('integrations.searxng_configured')}</span>
				{:else}
					<span class="text-xs text-text-subtle">{t('integrations.searxng_not_configured')}</span>
				{/if}
			</div>

			{#if isSearxngSaved()}
				<p class="text-sm text-success">{t('integrations.searxng_saved')}</p>
			{:else if isSearxngConfigured()}
				<div class="space-y-3">
					<p class="text-xs text-text-muted font-mono">{getSearxngConfiguredUrl()}</p>
					<div class="flex gap-2">
						<button
							onclick={() => checkSearxng(getSearxngConfiguredUrl())}
							disabled={isSearxngChecking()}
							class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover disabled:opacity-50"
						>
							{isSearxngChecking() ? t('integrations.searxng_checking') : t('integrations.searxng_check')}
						</button>
						<button
							onclick={removeSearxng}
							disabled={isSearxngSaving()}
							class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-error hover:border-error disabled:opacity-50"
						>
							{t('integrations.searxng_remove')}
						</button>
					</div>
					{#if getSearxngHealthy() === true}
						<p class="text-xs text-success">{t('integrations.searxng_healthy')}</p>
					{:else if getSearxngHealthy() === false}
						<p class="text-xs text-error">{t('integrations.searxng_check_failed')}</p>
					{/if}
				</div>
			{:else}
				<div class="space-y-3">
					<ol class="text-xs text-text-muted space-y-1.5 list-decimal list-inside mb-1">
						<li>{t('integrations.searxng_step1')} <code class="text-text-subtle bg-bg px-1 py-0.5 rounded text-[11px]">docker run -d -p 8888:8080 searxng/searxng</code></li>
						<li>{t('integrations.searxng_step2')}</li>
						<li class="text-text-subtle">{t('integrations.searxng_step3')}</li>
					</ol>
					<div>
						<label for="searxng-url" class="block text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.searxng_label')}</label>
						<div class="flex gap-2">
							<input
								id="searxng-url"
								value={getSearxngUrl()}
								oninput={(e) => setSearxngUrl((e.currentTarget as HTMLInputElement).value)}
								type="url"
								placeholder="http://localhost:8888"
								class="flex-1 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
							/>
							<button
								onclick={() => { if (getSearxngUrl().trim()) checkSearxng(getSearxngUrl().trim().replace(/\/+$/, '')); }}
								disabled={!getSearxngUrl().trim() || isSearxngChecking()}
								class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover disabled:opacity-50"
							>
								{isSearxngChecking() ? t('integrations.searxng_checking') : t('integrations.searxng_check')}
							</button>
						</div>
					</div>
					{#if getSearxngHealthy() === true}
						<p class="text-xs text-success">{t('integrations.searxng_healthy')}</p>
					{:else if getSearxngHealthy() === false}
						<p class="text-xs text-error">{t('integrations.searxng_check_failed')}</p>
					{/if}
					<button
						onclick={saveSearxng}
						disabled={!getSearxngUrl().trim() || isSearxngSaving()}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
					>
						{isSearxngSaving() ? t('settings.saving') : t('settings.save')}
					</button>
				</div>
			{/if}
		</div>
	{/if}
</div>
