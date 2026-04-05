<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { clearError } from '../stores/chat.svelte.js';
	import { onMount } from 'svelte';

	let apiKeyMissing = $state(false);
	let dismissed = $state(false);
	let showWizard = $state(false);

	// Wizard state
	let apiKey = $state('');
	let saving = $state(false);
	let saveError = $state('');
	let saveSuccess = $state(false);

	onMount(async () => {
		try {
			const res = await fetch(`${getApiBase()}/secrets/status`);
			if (res.ok) {
				const data = (await res.json()) as { configured: Record<string, boolean> };
				apiKeyMissing = !data.configured['api_key'];
				if (apiKeyMissing) {
					const wasDismissed = localStorage.getItem('lynox-setup-dismissed');
					showWizard = !wasDismissed;
					dismissed = !!wasDismissed;
				}
			}
		} catch { /* silent — StatusBar handles engine-down state */ }
	});

	function dismiss() {
		dismissed = true;
		showWizard = false;
		localStorage.setItem('lynox-setup-dismissed', '1');
	}

	function openWizard() {
		showWizard = true;
		saveError = '';
		saveSuccess = false;
	}

	async function saveApiKey() {
		const trimmed = apiKey.trim();
		if (!trimmed) return;
		saving = true;
		saveError = '';
		try {
			const res = await fetch(`${getApiBase()}/secrets/ANTHROPIC_API_KEY`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: trimmed }),
			});
			if (!res.ok) throw new Error('Failed to save');
			saveSuccess = true;
			apiKeyMissing = false;
			clearError();
			localStorage.removeItem('lynox-setup-dismissed');
			setTimeout(() => { showWizard = false; }, 1500);
		} catch {
			saveError = t('setup.save_error');
		}
		saving = false;
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && apiKey.trim()) saveApiKey();
		if (e.key === 'Escape') dismiss();
	}
</script>

<!-- Setup Wizard Modal -->
{#if showWizard && apiKeyMissing}
	<div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			class="bg-bg-subtle border border-border rounded-[var(--radius-lg)] shadow-2xl w-full max-w-md"
			role="dialog"
			aria-label={t('setup.title')}
			tabindex="0"
			onkeydown={onKeydown}
		>
			<div class="p-6 space-y-5">
				<!-- Header -->
				<div>
					<h2 class="text-lg font-semibold text-text">{t('setup.title')}</h2>
					<p class="text-sm text-text-secondary mt-1">{t('setup.subtitle')}</p>
				</div>

				<!-- Success state -->
				{#if saveSuccess}
					<div class="flex flex-col items-center gap-3 py-6">
						<div class="h-12 w-12 rounded-full bg-success/20 flex items-center justify-center">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-success" viewBox="0 0 20 20" fill="currentColor">
								<path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
							</svg>
						</div>
						<p class="text-sm text-success font-medium">{t('setup.success')}</p>
					</div>
				{:else}
					<!-- API Key input -->
					<div class="space-y-2">
						<label for="setup-api-key" class="text-sm font-medium text-text">{t('setup.label')}</label>
						<input
							id="setup-api-key"
							type="password"
							bind:value={apiKey}
							placeholder="sk-ant-..."
							autocomplete="off"
							class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2.5 text-sm text-text font-mono placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
						/>
						<p class="text-xs text-text-subtle">
							{t('setup.hint')}
							<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" class="text-accent-text hover:underline">console.anthropic.com</a>
						</p>
					</div>

					{#if saveError}
						<p class="text-sm text-danger">{saveError}</p>
					{/if}

					<!-- Actions -->
					<div class="flex items-center justify-between pt-1">
						<button
							onclick={dismiss}
							class="text-sm text-text-subtle hover:text-text transition-colors"
						>
							{t('setup.skip')}
						</button>
						<button
							onclick={saveApiKey}
							disabled={saving || !apiKey.trim()}
							class="rounded-[var(--radius-md)] bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{saving ? t('common.saving') : t('setup.save')}
						</button>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Banner (after wizard dismissed or on revisit) -->
{#if apiKeyMissing && !showWizard && !dismissed}
	<div role="alert" class="flex items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning shrink-0">
		<div class="flex items-center gap-2 min-w-0">
			<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clip-rule="evenodd" />
			</svg>
			<span>{t('banner.api_key_missing')}</span>
		</div>
		<div class="flex items-center gap-2 shrink-0">
			<button onclick={openWizard} class="rounded-[var(--radius-sm)] bg-warning/20 px-2.5 py-1 text-xs font-medium hover:bg-warning/30 transition-colors">
				{t('banner.api_key_action')}
			</button>
			<button onclick={dismiss} class="text-warning/60 hover:text-warning transition-colors" aria-label={t('banner.dismiss')}>
				<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
				</svg>
			</button>
		</div>
	</div>
{/if}
