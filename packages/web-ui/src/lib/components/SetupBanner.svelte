<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { clearError } from '../stores/chat.svelte.js';
	import { onMount } from 'svelte';

	type Provider = 'anthropic' | 'vertex' | 'custom' | 'openai';

	let apiKeyMissing = $state(false);
	let dismissed = $state(false);
	let showWizard = $state(false);
	let currentProvider = $state<Provider>('anthropic');
	let managedMode = $state<string | null>(null);
	let loaded = $state(false);

	// Wizard steps: 'provider' → 'credentials'
	let step = $state<'provider' | 'credentials'>('provider');
	let selectedProvider = $state<Provider>('anthropic');

	// Credential fields
	let anthropicKey = $state('');
	let vertexProjectId = $state('');
	let vertexRegion = $state('europe-west4');
	let customUrl = $state('');
	let customKey = $state('');
	let openaiUrl = $state('');
	let openaiKey = $state('');

	let saving = $state(false);
	let saveError = $state('');
	let saveSuccess = $state(false);

	onMount(async () => {
		try {
			const res = await fetch(`${getApiBase()}/secrets/status`);
			if (res.ok) {
				const data = (await res.json()) as { provider: string; managed?: string | null; configured: Record<string, boolean> };
				currentProvider = (data.provider ?? 'anthropic') as Provider;
				selectedProvider = currentProvider;
				managedMode = data.managed ?? null;

				// EU instances have pre-configured keys — never show wizard
				if (managedMode === 'eu') {
					apiKeyMissing = false;
					loaded = true;
					return;
				}

				apiKeyMissing = !data.configured['api_key'];
				if (apiKeyMissing) {
					const wasDismissed = localStorage.getItem('lynox-setup-dismissed');
					showWizard = !wasDismissed;
					dismissed = !!wasDismissed;
					// Managed BYOK: skip provider selection, go straight to Anthropic key
					if (managedMode) {
						selectedProvider = 'anthropic';
						step = 'credentials';
					}
				}
			}
		} catch { /* silent — StatusBar handles engine-down state */ }
		loaded = true;
	});

	function dismiss() {
		dismissed = true;
		showWizard = false;
		localStorage.setItem('lynox-setup-dismissed', '1');
	}

	function openWizard() {
		showWizard = true;
		step = 'provider';
		saveError = '';
		saveSuccess = false;
	}

	function selectProvider(p: Provider) {
		selectedProvider = p;
		step = 'credentials';
		saveError = '';
	}

	function goBack() {
		step = 'provider';
		saveError = '';
	}

	const canSave = $derived(
		selectedProvider === 'anthropic' ? !!anthropicKey.trim() :
		selectedProvider === 'vertex' ? (!!vertexProjectId.trim() && !!vertexRegion.trim()) :
		selectedProvider === 'custom' ? !!customUrl.trim() :
		selectedProvider === 'openai' ? (!!openaiUrl.trim() && !!openaiKey.trim()) :
		false
	);

	async function saveCredentials() {
		if (!canSave) return;
		saving = true;
		saveError = '';
		try {
			const base = getApiBase();

			// 1. Save provider config
			const providerConfig: Record<string, unknown> = { provider: selectedProvider };
			if (selectedProvider === 'vertex') {
				providerConfig['gcp_project_id'] = vertexProjectId.trim();
				providerConfig['gcp_region'] = vertexRegion.trim();
			}
			if (selectedProvider === 'custom') {
				providerConfig['api_base_url'] = customUrl.trim();
			}
			if (selectedProvider === 'openai') {
				providerConfig['api_base_url'] = openaiUrl.trim();
			}

			const configRes = await fetch(`${base}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(providerConfig),
			});
			if (!configRes.ok) throw new Error('Failed to save config');

			// 2. Save credentials to vault
			if (selectedProvider === 'anthropic') {
				await saveSecret('ANTHROPIC_API_KEY', anthropicKey.trim());
			} else if (selectedProvider === 'custom' && customKey.trim()) {
				await saveSecret('ANTHROPIC_API_KEY', customKey.trim());
			} else if (selectedProvider === 'openai') {
				await saveSecret('OPENAI_API_KEY', openaiKey.trim());
			}
			// vertex: credentials come from GOOGLE_APPLICATION_CREDENTIALS env var — no secret to save

			saveSuccess = true;
			apiKeyMissing = false;
			clearError();
			localStorage.removeItem('lynox-setup-dismissed');
			// Reload after short delay so the engine picks up the new credentials
			setTimeout(() => { window.location.reload(); }, 1500);
		} catch {
			saveError = t('setup.save_error');
		}
		saving = false;
	}

	async function saveSecret(name: string, value: string): Promise<void> {
		const res = await fetch(`${getApiBase()}/secrets/${encodeURIComponent(name)}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ value }),
		});
		if (!res.ok) throw new Error(`Failed to save ${name}`);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && canSave && step === 'credentials') saveCredentials();
		if (e.key === 'Escape') dismiss();
	}

	const providers: { id: Provider; label: string; desc: string }[] = [
		{ id: 'anthropic', label: 'Claude (Anthropic)', desc: 'setup.provider_anthropic_desc' },
		{ id: 'vertex', label: 'Claude (Vertex AI)', desc: 'setup.provider_vertex_desc' },
		{ id: 'custom', label: 'Custom Proxy', desc: 'setup.provider_custom_desc' },
		{ id: 'openai', label: 'OpenAI-compatible', desc: 'setup.provider_openai_desc' },
	];

	const subtitleKey = $derived(
		selectedProvider === 'vertex' ? 'setup.subtitle_vertex' :
		selectedProvider === 'custom' ? 'setup.subtitle_custom' :
		selectedProvider === 'openai' ? 'setup.subtitle_openai' :
		'setup.subtitle'
	);

	const inputClass = 'w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2.5 text-sm text-text font-mono placeholder:text-text-subtle focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent';
</script>

<!-- Setup Wizard Modal -->
{#if loaded && showWizard && apiKeyMissing}
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
					<h2 class="text-lg font-semibold text-text">{managedMode ? t('setup.title_byok') : t('setup.title')}</h2>
					{#if step === 'provider' && !managedMode}
						<p class="text-sm text-text-secondary mt-1">{t('setup.provider_select')}</p>
					{:else if managedMode}
						<p class="text-sm text-text-secondary mt-1">{t('setup.subtitle_byok')}</p>
					{:else}
						<p class="text-sm text-text-secondary mt-1">{t(subtitleKey)}</p>
					{/if}
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

				<!-- Step 1: Provider selection (self-hosted only) -->
				{:else if step === 'provider' && !managedMode}
					<div class="space-y-2">
						{#each providers as p}
							<button
								onclick={() => selectProvider(p.id)}
								class="w-full text-left rounded-[var(--radius-md)] border px-4 py-3 transition-all
									{selectedProvider === p.id && step === 'provider'
										? 'border-accent bg-accent/5'
										: 'border-border hover:border-accent/50 hover:bg-bg'}"
							>
								<span class="text-sm font-medium text-text">{p.label}</span>
								<span class="block text-xs text-text-subtle mt-0.5">{t(p.desc)}</span>
							</button>
						{/each}
					</div>

					<div class="flex items-center justify-between pt-1">
						<button
							onclick={dismiss}
							class="text-sm text-text-subtle hover:text-text transition-colors"
						>
							{t('setup.skip')}
						</button>
					</div>

				<!-- Step 2: Credentials -->
				{:else}
					<div class="space-y-3">
						{#if selectedProvider === 'anthropic'}
							<div class="space-y-2">
								<label for="setup-api-key" class="text-sm font-medium text-text">{t('setup.label')}</label>
								<input
									id="setup-api-key"
									type="password"
									bind:value={anthropicKey}
									placeholder="sk-ant-..."
									autocomplete="off"
									class={inputClass}
								/>
								<p class="text-xs text-text-subtle">
									{t('setup.hint')}
									<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" class="text-accent-text hover:underline">console.anthropic.com</a>
								</p>
							</div>

						{:else if selectedProvider === 'vertex'}
							<div class="space-y-2">
								<label for="setup-vertex-project" class="text-sm font-medium text-text">{t('setup.label_vertex_project')}</label>
								<input
									id="setup-vertex-project"
									type="text"
									bind:value={vertexProjectId}
									placeholder="lynox-prod"
									autocomplete="off"
									class={inputClass}
								/>
							</div>
							<div class="space-y-2">
								<label for="setup-vertex-region" class="text-sm font-medium text-text">{t('setup.label_vertex_region')}</label>
								<select
									id="setup-vertex-region"
									bind:value={vertexRegion}
									class={inputClass}
								>
									<option value="europe-west4">europe-west4 (Netherlands — EU residency)</option>
									<option value="europe-west1">europe-west1 (Belgium)</option>
									<option value="us-east5">us-east5 (Columbus)</option>
									<option value="us-central1">us-central1 (Iowa)</option>
								</select>
							</div>
							<p class="text-xs text-text-subtle">{t('setup.hint_vertex')}</p>

						{:else if selectedProvider === 'custom'}
							<div class="space-y-2">
								<label for="setup-custom-url" class="text-sm font-medium text-text">{t('setup.label_custom_url')}</label>
								<input
									id="setup-custom-url"
									type="url"
									bind:value={customUrl}
									placeholder="http://localhost:4000"
									autocomplete="off"
									class={inputClass}
								/>
							</div>
							<div class="space-y-2">
								<label for="setup-custom-key" class="text-sm font-medium text-text">{t('setup.label_custom_key')}</label>
								<input
									id="setup-custom-key"
									type="password"
									bind:value={customKey}
									placeholder="sk-..."
									autocomplete="off"
									class={inputClass}
								/>
							</div>
							<p class="text-xs text-text-subtle">{t('setup.hint_custom')}</p>

						{:else if selectedProvider === 'openai'}
							<div class="space-y-2">
								<label for="setup-openai-url" class="text-sm font-medium text-text">{t('setup.label_openai_url')}</label>
								<input
									id="setup-openai-url"
									type="url"
									bind:value={openaiUrl}
									placeholder="https://api.mistral.ai/v1"
									autocomplete="off"
									class={inputClass}
								/>
							</div>
							<div class="space-y-2">
								<label for="setup-openai-key" class="text-sm font-medium text-text">{t('setup.label_openai_key')}</label>
								<input
									id="setup-openai-key"
									type="password"
									bind:value={openaiKey}
									placeholder="sk-..."
									autocomplete="off"
									class={inputClass}
								/>
							</div>
							<p class="text-xs text-text-subtle">{t('setup.hint_openai')}</p>
						{/if}
					</div>

					{#if saveError}
						<p class="text-sm text-danger">{saveError}</p>
					{/if}

					<!-- Actions -->
					<div class="flex items-center justify-between pt-1">
						{#if !managedMode}
							<button
								onclick={goBack}
								class="text-sm text-text-subtle hover:text-text transition-colors"
							>
								{t('setup.back')}
							</button>
						{:else}
							<button
								onclick={dismiss}
								class="text-sm text-text-subtle hover:text-text transition-colors"
							>
								{t('onboard.vault_skip_btn')}
							</button>
						{/if}
						<button
							onclick={saveCredentials}
							disabled={saving || !canSave}
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
{#if loaded && apiKeyMissing && !showWizard && !dismissed}
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
