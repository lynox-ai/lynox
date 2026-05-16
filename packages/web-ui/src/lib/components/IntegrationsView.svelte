<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import MailSettings from './MailSettings.svelte';
	import WhatsAppSettings from './WhatsAppSettings.svelte';
	import {
		initNotifications,
		enablePushNotifications,
		disablePushNotifications,
		testPushNotification,
		getNotificationPermission,
		isSubscribed,
		isLoading as isPushLoading,
		isSupported as isPushSupported,
		isIosWithoutPwa,
	} from '../stores/notifications.svelte.js';
	import {
		isSecretsLoading,
		isApiKeyConfigured,
		isSearchConfigured,
		isSearxngConfigured,
		getSearxngConfiguredUrl,
		getApiKey,
		setApiKey,
		isApiKeySaving,
		loadSecretStatuses,
		saveAnthropicApiKey,
	} from '../stores/integrations/secrets.svelte.js';
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
	import {
		getPrefs,
		loadInboxPushPref,
		patchPrefs,
		patchThrottle,
		defaultBrowserTz,
	} from '../stores/integrations/notifications.svelte.js';
	import {
		getSearchKey,
		setSearchKey,
		isSearchSaving,
		isSearchSaved,
		saveSearch,
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

	async function copyText(text: string) {
		await navigator.clipboard.writeText(text);
		addToast(t('common.copied'), 'success', 1500);
	}

	let oauthClaimHandled = false;

	$effect(() => {
		initNotifications();
		void loadInboxPushPref();
		void loadManagedStatus();
		void loadGoogleStatus();
		void loadSecretStatuses();

		// Auto-claim Google tokens after OAuth redirect (managed flow)
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
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-6 mt-2">{t('integrations.title')}</h1>

	<!-- Anthropic API Key (hidden in managed — credentials are system-controlled) -->
	{#if !isManaged()}
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
			<div class="flex items-center justify-between mb-4">
				<div>
					<h2 class="font-medium">{t('integrations.anthropic')}</h2>
					<p class="text-xs text-text-muted mt-1">{t('integrations.anthropic_desc')}</p>
				</div>
				{#if isSecretsLoading()}
					<span class="text-xs text-text-subtle">{t('common.loading')}</span>
				{:else if isApiKeyConfigured()}
					<span class="text-xs text-success">{t('integrations.api_key_active')}</span>
				{:else}
					<span class="text-xs text-text-subtle">{t('integrations.not_configured')}</span>
				{/if}
			</div>

			<div class="space-y-3">
				{#if !isApiKeyConfigured()}
					<ol class="text-xs text-text-muted space-y-1.5 list-decimal list-inside mb-1">
						<li>{t('integrations.anthropic_step1')} <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80">console.anthropic.com</a></li>
						<li>{t('integrations.anthropic_step2')}</li>
					</ol>
				{/if}
				<div>
					<label for="api-key" class="block text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.api_key_label')}</label>
					<input
						id="api-key"
						value={getApiKey()}
						oninput={(e) => setApiKey((e.currentTarget as HTMLInputElement).value)}
						type="password"
						placeholder="sk-ant-..."
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
					/>
				</div>
				<button
					onclick={saveAnthropicApiKey}
					disabled={!getApiKey().trim() || isApiKeySaving()}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
				>
					{isApiKeySaving() ? t('settings.saving') : isApiKeyConfigured() ? t('integrations.api_key_update') : t('settings.save')}
				</button>
			</div>
		</div>
	{/if}

	<!-- Mail (IMAP/SMTP + app-password) -->
	<MailSettings />

	<!-- WhatsApp Business (Coexistence, BYOK) -->
	<WhatsAppSettings />

	<!-- Google Workspace -->
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

	<!-- Push Notifications -->
	{#if isIosWithoutPwa()}
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.push_notifications')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.push_desc')}</p>
			</div>
			<span class="text-xs text-warning">{t('integrations.push_ios_hint_short')}</span>
		</div>
		<p class="text-xs text-text-muted">{t('integrations.push_ios_hint')}</p>
	</div>
	{:else if isPushSupported()}
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.push_notifications')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.push_desc')}</p>
			</div>
			{#if isSubscribed()}
				<span class="text-xs text-success">{t('integrations.push_active')}</span>
			{:else if getNotificationPermission() === 'denied'}
				<span class="text-xs text-danger">{t('integrations.push_blocked')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.push_inactive')}</span>
			{/if}
		</div>

		{#if isSubscribed()}
			<div class="flex gap-2">
				<button
					onclick={async () => { const ok = await testPushNotification(); addToast(ok ? t('integrations.push_test_sent') : t('integrations.push_test_failed'), ok ? 'success' : 'error'); }}
					class="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-base"
				>
					{t('integrations.push_test')}
				</button>
				<button
					onclick={async () => { await disablePushNotifications(); addToast(t('integrations.push_disabled'), 'info'); }}
					disabled={isPushLoading()}
					class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/15 px-3 py-1.5 text-sm text-danger hover:bg-danger/25 disabled:opacity-50"
				>
					{t('integrations.push_disable')}
				</button>
			</div>
			<!-- Per-category opt-out + Quiet Hours + throttle + per-account
				mute. All keys live in the same envelope and are PATCHed
				deltas; backend defaults missing fields. -->
			{#if getPrefs()}
			{@const prefs = getPrefs()!}
			<div class="mt-4 space-y-3 border-t border-border pt-3">
				<label class="flex items-start gap-2 cursor-pointer text-sm">
					<input
						type="checkbox"
						checked={prefs.inboxPushEnabled}
						onchange={(e) => void patchPrefs({ inboxPushEnabled: (e.currentTarget as HTMLInputElement).checked })}
						class="mt-0.5"
					/>
					<span>
						<span class="text-text">{t('integrations.push_inbox_toggle')}</span>
						<span class="block text-xs text-text-muted">{t('integrations.push_inbox_toggle_hint')}</span>
					</span>
				</label>

				<!-- Quiet Hours -->
				<div class="rounded-[var(--radius-sm)] border border-border bg-bg p-3">
					<label class="flex items-start gap-2 cursor-pointer text-sm">
						<input
							type="checkbox"
							checked={prefs.quietHours.enabled}
							onchange={(e) => void patchPrefs({ quietHours: {
								enabled: (e.currentTarget as HTMLInputElement).checked,
								// Backfill the user's TZ on first enable so a server
								// without LYNOX_TZ doesn't silently mute everything in UTC.
								...(prefs.quietHours.tz === 'UTC' ? { tz: defaultBrowserTz() } : {}),
							} })}
							class="mt-0.5"
						/>
						<span>
							<span class="text-text">{t('integrations.push_quiet_hours_toggle')}</span>
							<span class="block text-xs text-text-muted">{t('integrations.push_quiet_hours_hint')}</span>
						</span>
					</label>
					{#if prefs.quietHours.enabled}
						<div class="mt-2 flex items-center gap-2 text-xs text-text-muted pl-6">
							<label class="flex items-center gap-1">
								{t('integrations.push_quiet_hours_from')}
								<input
									type="time"
									value={prefs.quietHours.start}
									onchange={(e) => void patchPrefs({ quietHours: { start: (e.currentTarget as HTMLInputElement).value } })}
									class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-text"
								/>
							</label>
							<label class="flex items-center gap-1">
								{t('integrations.push_quiet_hours_to')}
								<input
									type="time"
									value={prefs.quietHours.end}
									onchange={(e) => void patchPrefs({ quietHours: { end: (e.currentTarget as HTMLInputElement).value } })}
									class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-text"
								/>
							</label>
							<span class="text-text-subtle">({prefs.quietHours.tz})</span>
						</div>
					{/if}
				</div>

				<!-- Throttle -->
				<div class="rounded-[var(--radius-sm)] border border-border bg-bg p-3 text-sm">
					<div class="text-text mb-2">{t('integrations.push_throttle_title')}</div>
					<div class="flex items-center gap-3 text-xs text-text-muted">
						<label class="flex items-center gap-1">
							<input
								type="number"
								min="1"
								max="10"
								value={prefs.perMinute}
								onchange={(e) => patchThrottle('perMinute', (e.currentTarget as HTMLInputElement).value)}
								class="w-16 rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-text"
							/>
							{t('integrations.push_throttle_per_minute')}
						</label>
						<label class="flex items-center gap-1">
							<input
								type="number"
								min="1"
								max="60"
								value={prefs.perHour}
								onchange={(e) => patchThrottle('perHour', (e.currentTarget as HTMLInputElement).value)}
								class="w-16 rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-text"
							/>
							{t('integrations.push_throttle_per_hour')}
						</label>
					</div>
				</div>

				<!-- Per-account mute -->
				{#if prefs.accounts.length > 1}
				<div class="rounded-[var(--radius-sm)] border border-border bg-bg p-3 text-sm">
					<div class="text-text mb-2">{t('integrations.push_per_account_title')}</div>
					<div class="space-y-1.5">
						{#each prefs.accounts as acct (acct.id)}
							<label class="flex items-center gap-2 text-xs cursor-pointer">
								<input
									type="checkbox"
									checked={!acct.muted}
									onchange={(e) => void patchPrefs({ accounts: { [acct.id]: !(e.currentTarget as HTMLInputElement).checked } })}
								/>
								<span class="text-text">{acct.displayName}</span>
								<span class="text-text-subtle">&lt;{acct.address}&gt;</span>
							</label>
						{/each}
					</div>
				</div>
				{/if}
			</div>
			{/if}
		{:else if getNotificationPermission() === 'denied'}
			<p class="text-xs text-text-muted">{t('integrations.push_denied_hint')}</p>
		{:else}
			<button
				onclick={async () => { const ok = await enablePushNotifications(); addToast(ok ? t('integrations.push_enabled') : t('integrations.push_enable_failed'), ok ? 'success' : 'error'); }}
				disabled={isPushLoading()}
				class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
			>
				{isPushLoading() ? t('common.loading') : t('integrations.push_enable')}
			</button>
		{/if}
	</div>
	{/if}

	<!-- Web Search (hidden in managed — SearXNG pre-configured) -->
	{#if !isManaged()}
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.search')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.search_desc')}</p>
			</div>
			{#if isSecretsLoading()}
				<span class="text-xs text-text-subtle">{t('common.loading')}</span>
			{:else if isSearchConfigured()}
				<span class="text-xs text-success">{t('integrations.search_configured')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.search_not_configured')}</span>
			{/if}
		</div>

		{#if isSearchSaved()}
			<p class="text-sm text-success">{t('integrations.search_saved')}</p>
		{:else}
			<div class="space-y-3">
				{#if !isSearchConfigured()}
					<ol class="text-xs text-text-muted space-y-1.5 list-decimal list-inside mb-1">
						<li>{t('integrations.search_step1')} <a href="https://app.tavily.com/sign-in" target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80">tavily.com</a></li>
						<li>{t('integrations.search_step2')}</li>
						<li class="text-text-subtle">{t('integrations.search_step3')}</li>
					</ol>
				{/if}
				<div>
					<label for="search-key" class="block text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.tavily_label')}</label>
					<input
						id="search-key"
						value={getSearchKey()}
						oninput={(e) => setSearchKey((e.currentTarget as HTMLInputElement).value)}
						type="password"
						placeholder="tvly-..."
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
					/>
				</div>
				<button
					onclick={saveSearch}
					disabled={!getSearchKey().trim() || isSearchSaving()}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
				>
					{isSearchSaving() ? t('settings.saving') : t('settings.save')}
				</button>
			</div>
		{/if}
	</div>
	{/if}

	<!-- SearXNG (hidden in managed — pre-configured as sidecar) -->
	{#if !isManaged()}
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
