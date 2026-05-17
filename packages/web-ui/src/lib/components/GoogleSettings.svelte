<script lang="ts">
	// === Google Workspace channel card ===
	//
	// Extracted from IntegrationsView.svelte during PRD-IA-V2 P3-PR-A2
	// channel route split. State lives in stores/integrations/google.svelte.ts
	// (shipped in P3-PR-A1); this component just renders the card and owns
	// the OAuth-claim side-effect (only fires on this route now).

	import { onDestroy } from 'svelte';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { isManaged, loadManagedStatus } from '../stores/integrations/managed.svelte.js';
	import {
		getGoogleStatus,
		isGoogleLoading,
		getDeviceFlow,
		isConnecting,
		isRevoking,
		getGoogleClientId,
		setGoogleClientId,
		getGoogleClientSecret,
		setGoogleClientSecret,
		isGoogleCredSaving,
		isGoogleCredSaved,
		getScopeMode,
		setScopeMode,
		isManagedGoogleClaiming,
		isScopeMismatch,
		loadGoogleStatus,
		saveGoogleCredentials,
		startGoogleAuth,
		revokeGoogle,
		resetGoogleCredentials,
		claimManagedGoogleTokens,
		stopAuthPoll,
	} from '../stores/integrations/google.svelte.js';

	async function copyText(text: string) {
		await navigator.clipboard.writeText(text);
		addToast(t('common.copied'), 'success', 1500);
	}

	let oauthClaimHandled = $state(false);

	$effect(() => {
		void loadManagedStatus();
		void loadGoogleStatus();

		// Auto-claim Google tokens after OAuth redirect (managed flow).
		// Only fires on this route — previously lived in IntegrationsView.
		if (!oauthClaimHandled && typeof window !== 'undefined') {
			const params = new URLSearchParams(window.location.search);
			const claimNonce = params.get('google_oauth');
			if (claimNonce && claimNonce !== 'success') {
				oauthClaimHandled = true;
				// Clean URL param without reload
				const url = new URL(window.location.href);
				url.searchParams.delete('google_oauth');
				window.history.replaceState({}, '', url.toString());
				// Claim tokens using nonce
				void claimManagedGoogleTokens(claimNonce);
			}
		}
	});

	onDestroy(() => {
		stopAuthPoll();
	});
</script>

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<a href="/app/settings/channels" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.channels.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-6 mt-2">{t('settings.channels.google')}</h1>

	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.google_workspace')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.google_services')}</p>
			</div>
			{#if isGoogleLoading()}
				<span class="text-xs text-text-subtle">{t('common.loading')}</span>
			{:else if getGoogleStatus()?.authenticated}
				<span class="text-xs text-success">{t('integrations.connected')}</span>
			{:else if getGoogleStatus()?.available}
				<span class="text-xs text-text-subtle">{t('integrations.not_connected')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.not_configured')}</span>
			{/if}
		</div>

		{#if isGoogleLoading()}
			<!-- loading -->
		{:else if isManagedGoogleClaiming()}
			<div class="flex items-center gap-2 text-sm text-text-muted">
				<span class="inline-block h-4 w-4 border-2 border-accent border-t-transparent rounded-full animate-spin"></span>
				{t('integrations.connecting')}
			</div>
		{:else if !getGoogleStatus()?.available}
			<!-- Manual credential setup (managed: Web app + redirect URI, self-hosted: Desktop app) -->
			<div class="space-y-3">
				{#if isGoogleCredSaved()}
					<p class="text-sm text-success">{t('integrations.credentials_saved')}</p>
				{:else}
					<p class="text-xs text-text-muted mb-3">
						{isManaged() ? t('integrations.google_setup_guide_suffix_managed') : t('integrations.google_setup_guide_suffix')}:
					</p>
					<a
						href="https://docs.lynox.ai/integrations/google-workspace/#setup"
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-1.5 text-xs font-medium text-accent-text hover:border-border-hover hover:bg-bg-hover transition-colors mb-4"
					>
						{t('integrations.google_setup_guide')}
						<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
					</a>
					{#if isManaged()}
						<div class="mb-3">
							<p class="text-xs text-text-muted mb-1">{t('integrations.google_redirect_uri_label')}</p>
							<button onclick={() => copyText(`${window.location.origin}/api/google/callback`)} class="w-full text-left rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-xs font-mono text-text-muted hover:border-border-hover cursor-pointer" title={t('common.copy')}>
								{window.location.origin}/api/google/callback
							</button>
						</div>
					{/if}
					<p class="text-xs text-text-muted mb-2">{t('integrations.google_paste_credentials')}</p>
					<div class="space-y-2">
						<input
							value={getGoogleClientId()}
							oninput={(e) => setGoogleClientId((e.currentTarget as HTMLInputElement).value)}
							type="password"
							placeholder="Client ID"
							class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
						/>
						<input
							value={getGoogleClientSecret()}
							oninput={(e) => setGoogleClientSecret((e.currentTarget as HTMLInputElement).value)}
							type="password"
							placeholder="Client Secret"
							class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
						/>
					</div>
					<button
						onclick={saveGoogleCredentials}
						disabled={!getGoogleClientId().trim() || !getGoogleClientSecret().trim() || isGoogleCredSaving()}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
					>
						{isGoogleCredSaving() ? t('settings.saving') : t('integrations.save_credentials')}
					</button>
				{/if}
			</div>
		{:else if getGoogleStatus()?.authenticated}
			<!-- Connected -->
			<div class="space-y-3">
				<!-- Scope mode toggle -->
				<div>
					<p class="text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.access_level')}</p>
					<div class="inline-flex rounded-[var(--radius-md)] border border-border overflow-hidden">
						<button
							onclick={() => setScopeMode('readonly')}
							class="px-3 py-1.5 text-xs transition-colors {getScopeMode() === 'readonly' ? 'bg-accent text-text' : 'bg-bg text-text-muted hover:bg-bg-hover'}"
						>{t('integrations.scope_readonly')}</button>
						<button
							onclick={() => setScopeMode('full')}
							class="px-3 py-1.5 text-xs transition-colors {getScopeMode() === 'full' ? 'bg-accent text-text' : 'bg-bg text-text-muted hover:bg-bg-hover'}"
						>{t('integrations.scope_full')}</button>
					</div>
					{#if getScopeMode() === 'full'}
						<p class="text-xs text-text-subtle mt-1">{t('integrations.scope_full_desc')}</p>
					{/if}
				</div>
				{#if isScopeMismatch()}
					<button
						onclick={startGoogleAuth}
						disabled={isConnecting()}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
					>
						{isConnecting() ? t('integrations.connecting') : t('integrations.reconnect_google')}
					</button>
					<p class="text-xs text-warning">{t('integrations.scope_change_hint')}</p>
				{/if}
				{#if getGoogleStatus()?.scopes && getGoogleStatus()!.scopes!.length > 0}
					{@const scopes = getGoogleStatus()!.scopes!}
					{@const services = [
						{ name: 'Gmail', read: scopes.some(s => s.includes('gmail.readonly')), write: scopes.some(s => s.includes('gmail.send') || s.includes('gmail.modify')) },
						{ name: 'Calendar', read: scopes.some(s => s.includes('calendar.readonly')), write: scopes.some(s => s.includes('calendar.events')) },
						{ name: 'Drive', read: scopes.some(s => s.includes('drive.readonly')), write: scopes.some(s => s.includes('/drive') && !s.includes('.readonly')) },
						{ name: 'Sheets', read: scopes.some(s => s.includes('spreadsheets.readonly')), write: scopes.some(s => s.includes('/spreadsheets') && !s.includes('.readonly')) },
						{ name: 'Docs', read: scopes.some(s => s.includes('documents.readonly')), write: scopes.some(s => s.includes('/documents') && !s.includes('.readonly')) },
					].filter(s => s.read || s.write)}
					<div class="flex flex-wrap gap-x-4 gap-y-1">
						{#each services as svc}
							<span class="text-xs text-text-muted">
								<span class="text-text">{svc.name}</span> — {svc.write ? t('integrations.scope_label_readwrite') : t('integrations.scope_label_read')}
							</span>
						{/each}
					</div>
				{/if}
				<button
					onclick={revokeGoogle}
					disabled={isRevoking()}
					class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/15 px-3 py-1.5 text-sm text-danger hover:bg-danger/25 disabled:opacity-50"
				>
					{isRevoking() ? t('integrations.disconnecting') : t('integrations.disconnect')}
				</button>
			</div>
		{:else if getDeviceFlow()}
			<!-- Device flow active -->
			{@const flow = getDeviceFlow()!}
			<div class="space-y-3">
				<p class="text-sm text-text-muted">{t('integrations.device_flow_hint')}</p>
				<div class="rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 p-4 text-center space-y-2">
					<a href={flow.verificationUrl} target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80 text-sm break-all">
						{flow.verificationUrl}
					</a>
					<button onclick={() => copyText(flow.userCode)} class="text-2xl font-mono font-bold text-text tracking-widest hover:text-accent-text transition-colors cursor-pointer" title={t('common.copy')}>{flow.userCode}</button>
				</div>
				<p class="text-xs text-text-subtle">{t('integrations.waiting_auth')}</p>
			</div>
		{:else}
			<!-- Credentials set, not connected -->
			<div class="space-y-2">
				<div class="mb-1">
					<p class="text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.access_level')}</p>
					<div class="inline-flex rounded-[var(--radius-md)] border border-border overflow-hidden">
						<button
							onclick={() => setScopeMode('readonly')}
							class="px-3 py-1.5 text-xs transition-colors {getScopeMode() === 'readonly' ? 'bg-accent text-text' : 'bg-bg text-text-muted hover:bg-bg-hover'}"
						>{t('integrations.scope_readonly')}</button>
						<button
							onclick={() => setScopeMode('full')}
							class="px-3 py-1.5 text-xs transition-colors {getScopeMode() === 'full' ? 'bg-accent text-text' : 'bg-bg text-text-muted hover:bg-bg-hover'}"
						>{t('integrations.scope_full')}</button>
					</div>
					{#if getScopeMode() === 'full'}
						<p class="text-xs text-text-subtle mt-1">{t('integrations.scope_full_desc')}</p>
					{/if}
				</div>
				<button
					onclick={startGoogleAuth}
					disabled={isConnecting()}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
				>
					{isConnecting() ? t('integrations.connecting') : t('integrations.connect_google')}
				</button>
				<p class="text-xs text-text-subtle">{isManaged() ? t('integrations.redirect_flow_preview') : t('integrations.device_flow_preview')}</p>
				<button
					onclick={resetGoogleCredentials}
					class="text-xs text-text-subtle hover:text-text-muted transition-colors"
				>
					{t('integrations.change_credentials')}
				</button>
			</div>
		{/if}
	</div>
</div>
