<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
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

	async function copyText(text: string) {
		await navigator.clipboard.writeText(text);
		addToast(t('common.copied'), 'success', 1500);
	}

	// --- Google OAuth ---
	interface GoogleStatus {
		available: boolean;
		authenticated?: boolean;
		scopes?: string[];
		expiresAt?: string | null;
		hasRefreshToken?: boolean;
	}
	interface DeviceFlow { verificationUrl: string; userCode: string; }

	let googleStatus = $state<GoogleStatus | null>(null);
	let googleLoading = $state(true);
	let flow = $state<DeviceFlow | null>(null);
	let connecting = $state(false);
	let revoking = $state(false);
	let googleClientId = $state('');
	let googleClientSecret = $state('');
	let googleCredSaving = $state(false);
	let googleCredSaved = $state(false);

	async function loadGoogleStatus() {
		googleLoading = true;
		try {
			const res = await fetch(`${getApiBase()}/google/status`);
			if (!res.ok) throw new Error();
			googleStatus = (await res.json()) as GoogleStatus;
		} catch {
			googleStatus = null;
		}
		googleLoading = false;
	}

	async function saveGoogleCredentials() {
		const trimmedId = googleClientId.trim();
		const trimmedSecret = googleClientSecret.trim();
		if (!trimmedId || !trimmedSecret) return;
		googleCredSaving = true;
		try {
			const [r1, r2] = await Promise.all([
				fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_ID`, {
					method: 'PUT', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ value: trimmedId })
				}),
				fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_SECRET`, {
					method: 'PUT', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ value: trimmedSecret })
				}),
			]);
			if (!r1.ok || !r2.ok) throw new Error();
			googleClientId = '';
			googleClientSecret = '';
			googleCredSaved = true;
			addToast(t('integrations.credentials_saved'), 'success');
			// Reload Google integration in the running Engine (no restart needed)
			await fetch(`${getApiBase()}/google/reload`, { method: 'POST' });
			await new Promise((r) => setTimeout(r, 500));
			googleCredSaved = false;
			await loadGoogleStatus();
			// Auto-start auth flow after credentials are saved
			if (googleStatus?.available && !googleStatus.authenticated) {
				await startGoogleAuth();
			}
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		googleCredSaving = false;
	}

	let authPollInterval: ReturnType<typeof setInterval> | null = null;

	async function startGoogleAuth() {
		connecting = true;
		flow = null;
		try {
			const res = await fetch(`${getApiBase()}/google/auth`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			if (res.ok) {
				const data = (await res.json()) as { authUrl?: string; verificationUrl?: string; userCode?: string };
				if (data.authUrl) {
					// Redirect flow (managed/web-hosted) — redirect to Google consent
					window.location.href = data.authUrl;
					return;
				}
				flow = data as DeviceFlow;
				// Device flow — auto-open verification URL and copy code to clipboard
				if (flow?.verificationUrl) {
					window.open(flow.verificationUrl, '_blank', 'noopener');
					navigator.clipboard.writeText(flow.userCode).then(() => {
						addToast(t('integrations.google_code_copied'), 'success', 4000);
					}).catch(() => {});
				}
			} else {
				const err = (await res.json()) as { error?: string };
				const errMsg = err.error ?? '';
				if (errMsg.includes('unauthorized_client')) {
					addToast(t('integrations.google_wrong_client_type'), 'error', 12000);
				} else if (errMsg.includes('invalid_client')) {
					addToast(t('integrations.google_invalid_credentials'), 'error', 12000);
				} else {
					addToast(errMsg || t('common.error'), 'error', 6000);
				}
			}
		} catch {
			addToast(t('common.error'), 'error');
		}
		connecting = false;
		if (authPollInterval) clearInterval(authPollInterval);
		authPollInterval = setInterval(async () => {
			try {
				const r = await fetch(`${getApiBase()}/google/status`);
				if (!r.ok) return;
				const s = (await r.json()) as GoogleStatus;
				if (s.authenticated) {
					googleStatus = s;
					flow = null;
					if (authPollInterval) { clearInterval(authPollInterval); authPollInterval = null; }
				}
			} catch { /* ignore */ }
		}, 3000);
		setTimeout(() => { if (authPollInterval) { clearInterval(authPollInterval); authPollInterval = null; } }, 5 * 60_000);
	}

	async function revokeGoogle() {
		revoking = true;
		try {
			const res = await fetch(`${getApiBase()}/google/revoke`, { method: 'POST' });
			if (!res.ok) throw new Error();
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		revoking = false;
		await loadGoogleStatus();
	}

	async function resetGoogleCredentials() {
		try {
			await Promise.all([
				fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_ID`, { method: 'DELETE' }),
				fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_SECRET`, { method: 'DELETE' }),
			]);
			await fetch(`${getApiBase()}/google/reload`, { method: 'POST' });
			flow = null;
			googleCredSaved = false;
			await loadGoogleStatus();
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
	}

	// --- Telegram Wizard ---
	type TgStep = 'idle' | 'token' | 'waiting' | 'detected' | 'error';
	let tgStep = $state<TgStep>('idle');
	let tgToken = $state('');
	let tgBotName = $state('');
	let tgBotUsername = $state('');
	let tgDetectedChatId = $state<number | null>(null);
	let tgDetectedName = $state('');
	let tgError = $state('');
	let tgValidating = $state(false);
	let tgSaving = $state(false);
	let tgDisconnecting = $state(false);
	let telegramConfigured = $state(false);
	let tgPollInterval: ReturnType<typeof setInterval> | null = null;

	async function tgValidateToken() {
		if (!tgToken.trim()) return;
		tgValidating = true;
		tgError = '';
		try {
			const res = await fetch(`${getApiBase()}/telegram/setup`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ token: tgToken.trim() }),
			});
			if (!res.ok) {
				tgError = t('integrations.telegram_invalid_token');
				tgStep = 'error';
				tgValidating = false;
				return;
			}
			const data = (await res.json()) as { botName: string; botUsername: string };
			tgBotName = data.botName;
			tgBotUsername = data.botUsername;
			tgStep = 'waiting';
			tgStartPolling();
		} catch {
			tgError = t('integrations.telegram_invalid_token');
			tgStep = 'error';
		}
		tgValidating = false;
	}

	function tgStartPolling() {
		tgStopPolling();
		tgPollInterval = setInterval(async () => {
			try {
				const res = await fetch(`${getApiBase()}/telegram/setup`);
				if (!res.ok) return;
				const data = (await res.json()) as { status: string; chatId?: number; firstName?: string };
				if (data.status === 'detected' && data.chatId) {
					tgDetectedChatId = data.chatId;
					tgDetectedName = data.firstName ?? '';
					tgStep = 'detected';
					tgStopPolling();
				} else if (data.status === 'timeout') {
					tgError = t('integrations.telegram_timeout');
					tgStep = 'error';
					tgStopPolling();
				}
			} catch { /* ignore */ }
		}, 3000);
		// Hard stop after 2.5 min (server timeout is 2 min)
		setTimeout(() => { if (tgPollInterval) tgStopPolling(); }, 150_000);
	}

	function tgStopPolling() {
		if (tgPollInterval) { clearInterval(tgPollInterval); tgPollInterval = null; }
	}

	async function tgSaveAndFinish() {
		if (!tgDetectedChatId) return;
		tgSaving = true;
		try {
			const [r1, r2] = await Promise.all([
				fetch(`${getApiBase()}/secrets/TELEGRAM_BOT_TOKEN`, {
					method: 'PUT', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ value: tgToken.trim() }),
				}),
				fetch(`${getApiBase()}/secrets/TELEGRAM_ALLOWED_CHAT_IDS`, {
					method: 'PUT', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ value: String(tgDetectedChatId) }),
				}),
			]);
			if (!r1.ok || !r2.ok) throw new Error();
			// Cleanup setup state
			await fetch(`${getApiBase()}/telegram/setup`, { method: 'DELETE' });
			addToast(t('integrations.telegram_saved'), 'success');
			tgReset();
			await loadSecretStatuses();
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		tgSaving = false;
	}

	async function tgDisconnect() {
		tgDisconnecting = true;
		try {
			await Promise.all([
				fetch(`${getApiBase()}/secrets/TELEGRAM_BOT_TOKEN`, { method: 'DELETE' }),
				fetch(`${getApiBase()}/secrets/TELEGRAM_ALLOWED_CHAT_IDS`, { method: 'DELETE' }),
			]);
			await loadSecretStatuses();
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		tgDisconnecting = false;
	}

	function tgCancel() {
		tgStopPolling();
		fetch(`${getApiBase()}/telegram/setup`, { method: 'DELETE' }).catch(() => {});
		tgReset();
	}

	function tgReset() {
		tgStep = 'idle';
		tgToken = '';
		tgBotName = '';
		tgBotUsername = '';
		tgDetectedChatId = null;
		tgDetectedName = '';
		tgError = '';
		tgStopPolling();
	}

	// --- Managed mode detection ---
	let managedTier = $state<string | undefined>(undefined);
	const managed = $derived(!!managedTier);
	let managedGoogleOAuthAvailable = $state(false);
	let managedGoogleClaiming = $state(false);

	async function loadManagedStatus() {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) return;
			const data = (await res.json()) as Record<string, unknown>;
			if (typeof data['managed'] === 'string') managedTier = data['managed'];

			// Managed Google OAuth broker disabled — Google requires CASA security audit
			// ($4-15K+) for third-party apps accessing user data. All deployments
			// (self-hosted + managed) use per-user Desktop App credentials instead.
			managedGoogleOAuthAvailable = false;
		} catch { /* ignore */ }
	}

	async function startManagedGoogleOAuth() {
		try {
			const res = await fetch(`${getApiBase()}/google/oauth-url`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { url: string };
			if (data.url) {
				// Validate the control plane URL is reachable before redirecting
				try {
					const check = await fetch(data.url, { method: 'HEAD', mode: 'no-cors' }).catch(() => null);
					// no-cors HEAD always succeeds — redirect and let the user see the result
					window.location.href = data.url;
				} catch {
					// Control plane unreachable — fall back to self-hosted instructions
					managedGoogleOAuthAvailable = false;
					addToast(t('integrations.google_oauth_unavailable'), 'error');
				}
			}
		} catch {
			// Engine doesn't have control plane config — show self-hosted flow
			managedGoogleOAuthAvailable = false;
			addToast(t('integrations.google_oauth_unavailable'), 'error');
		}
	}

	async function claimManagedGoogleTokens(claimNonce: string) {
		managedGoogleClaiming = true;
		try {
			const res = await fetch(`${getApiBase()}/google/claim-managed`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ claim_nonce: claimNonce }),
			});
			if (res.ok) {
				addToast(t('integrations.google_connected_managed'), 'success');
				await loadGoogleStatus();
			} else {
				const data = (await res.json().catch(() => ({}))) as { error?: string };
				addToast(data.error ?? t('common.error'), 'error');
			}
		} catch {
			addToast(t('common.error'), 'error');
		}
		managedGoogleClaiming = false;
	}

	// --- Anthropic API Key ---
	let apiKey = $state('');
	let apiKeySaving = $state(false);
	let apiKeyConfigured = $state(false);

	async function saveApiKey() {
		if (!apiKey.trim()) return;
		apiKeySaving = true;
		try {
			const res = await fetch(`${getApiBase()}/secrets/ANTHROPIC_API_KEY`, {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: apiKey.trim() }),
			});
			if (!res.ok) throw new Error();
			apiKey = '';
			addToast(t('integrations.api_key_saved'), 'success');
			await loadSecretStatuses();
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		apiKeySaving = false;
	}

	// --- Web Search ---
	let searchKey = $state('');
	let searchSaving = $state(false);
	let searchSaved = $state(false);
	let searchConfigured = $state(false);

	// --- SearXNG ---
	let searxngUrl = $state('');
	let searxngSaving = $state(false);
	let searxngSaved = $state(false);
	let searxngConfigured = $state(false);
	let searxngConfiguredUrl = $state('');
	let searxngChecking = $state(false);
	let searxngHealthy = $state<boolean | null>(null);

	let secretsLoading = $state(true);

	async function loadSecretStatuses() {
		secretsLoading = true;
		try {
			const res = await fetch(`${getApiBase()}/secrets/status`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { configured: { telegram: boolean; search: boolean; api_key: boolean; searxng: boolean }; searxng_url: string | null };
			apiKeyConfigured = data.configured.api_key;
			telegramConfigured = data.configured.telegram;
			searchConfigured = data.configured.search;
			searxngConfigured = data.configured.searxng;
			searxngConfiguredUrl = data.searxng_url ?? '';
		} catch { /* ignore */ }
		secretsLoading = false;
	}

	async function saveSearch() {
		if (!searchKey.trim()) return;
		searchSaving = true;
		try {
			const res = await fetch(`${getApiBase()}/secrets/TAVILY_API_KEY`, {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: searchKey })
			});
			if (!res.ok) throw new Error();
			searchKey = '';
			searchSaved = true;
			setTimeout(() => (searchSaved = false), 2000);
			await loadSecretStatuses();
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		searchSaving = false;
	}

	async function checkSearxng(url: string) {
		searxngChecking = true;
		searxngHealthy = null;
		try {
			const res = await fetch(`${getApiBase()}/searxng/check`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url })
			});
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { healthy: boolean };
			searxngHealthy = data.healthy;
		} catch {
			searxngHealthy = false;
		}
		searxngChecking = false;
	}

	async function saveSearxng() {
		const url = searxngUrl.trim().replace(/\/+$/, '');
		if (!url) return;
		searxngSaving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ searxng_url: url })
			});
			if (!res.ok) throw new Error();
			searxngUrl = '';
			searxngSaved = true;
			searxngHealthy = null;
			setTimeout(() => (searxngSaved = false), 2000);
			await loadSecretStatuses();
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		searxngSaving = false;
	}

	async function removeSearxng() {
		searxngSaving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ searxng_url: null })
			});
			if (!res.ok) throw new Error();
			searxngConfigured = false;
			searxngConfiguredUrl = '';
			searxngHealthy = null;
			await loadSecretStatuses();
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		searxngSaving = false;
	}

	// Load all statuses on mount
	import { onDestroy } from 'svelte';

	let oauthClaimHandled = false;

	$effect(() => {
		initNotifications();
		loadManagedStatus();
		loadGoogleStatus();
		loadSecretStatuses();

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
				claimManagedGoogleTokens(claimNonce);
			}
		}
	});

	onDestroy(() => {
		if (authPollInterval) { clearInterval(authPollInterval); authPollInterval = null; }
		tgStopPolling();
	});
</script>

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-6 mt-2">{t('integrations.title')}</h1>

	<!-- Anthropic API Key (hidden in managed — credentials are system-controlled) -->
	{#if !managed}
		<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
			<div class="flex items-center justify-between mb-4">
				<div>
					<h2 class="font-medium">{t('integrations.anthropic')}</h2>
					<p class="text-xs text-text-muted mt-1">{t('integrations.anthropic_desc')}</p>
				</div>
				{#if secretsLoading}
					<span class="text-xs text-text-subtle">{t('common.loading')}</span>
				{:else if apiKeyConfigured}
					<span class="text-xs text-success">{t('integrations.api_key_active')}</span>
				{:else}
					<span class="text-xs text-text-subtle">{t('integrations.not_configured')}</span>
				{/if}
			</div>

			<div class="space-y-3">
				{#if !apiKeyConfigured}
					<ol class="text-xs text-text-muted space-y-1.5 list-decimal list-inside mb-1">
						<li>{t('integrations.anthropic_step1')} <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80">console.anthropic.com</a></li>
						<li>{t('integrations.anthropic_step2')}</li>
					</ol>
				{/if}
				<div>
					<label for="api-key" class="block text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.api_key_label')}</label>
					<input
						id="api-key"
						bind:value={apiKey}
						type="password"
						placeholder="sk-ant-..."
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
					/>
				</div>
				<button
					onclick={saveApiKey}
					disabled={!apiKey.trim() || apiKeySaving}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
				>
					{apiKeySaving ? t('settings.saving') : apiKeyConfigured ? t('integrations.api_key_update') : t('settings.save')}
				</button>
			</div>
		</div>
	{/if}

	<!-- Google Workspace -->
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.google_workspace')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.google_services')}</p>
			</div>
			{#if googleLoading}
				<span class="text-xs text-text-subtle">{t('common.loading')}</span>
			{:else if googleStatus?.authenticated}
				<span class="text-xs text-success">{t('integrations.connected')}</span>
			{:else if googleStatus?.available}
				<span class="text-xs text-text-subtle">{t('integrations.not_connected')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.not_configured')}</span>
			{/if}
		</div>

		{#if googleLoading}
			<!-- loading -->
		{:else if managedGoogleClaiming}
			<div class="flex items-center gap-2 text-sm text-text-muted">
				<span class="inline-block h-4 w-4 border-2 border-accent border-t-transparent rounded-full animate-spin"></span>
				{t('integrations.connecting')}
			</div>
		{:else if !googleStatus?.available}
			<!-- Manual credential setup (managed: Web app + redirect URI, self-hosted: Desktop app) -->
			<div class="space-y-3">
				{#if googleCredSaved}
					<p class="text-sm text-success">{t('integrations.credentials_saved')}</p>
				{:else}
					<p class="text-xs text-text-muted mb-3">
						{managed ? t('integrations.google_setup_guide_suffix_managed') : t('integrations.google_setup_guide_suffix')}:
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
					{#if managed}
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
							bind:value={googleClientId}
							type="password"
							placeholder="Client ID"
							class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
						/>
						<input
							bind:value={googleClientSecret}
							type="password"
							placeholder="Client Secret"
							class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
						/>
					</div>
					<button
						onclick={saveGoogleCredentials}
						disabled={!googleClientId.trim() || !googleClientSecret.trim() || googleCredSaving}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
					>
						{googleCredSaving ? t('settings.saving') : t('integrations.save_credentials')}
					</button>
				{/if}
			</div>
		{:else if googleStatus.authenticated}
			<!-- Connected -->
			<div class="space-y-3">
				{#if googleStatus.scopes && googleStatus.scopes.length > 0}
					<div>
						<p class="text-xs font-mono uppercase tracking-widest text-text-subtle mb-1">{t('integrations.permissions')}</p>
						<div class="flex flex-wrap gap-1">
							{#each googleStatus.scopes as scope}
								<span class="rounded-[var(--radius-sm)] bg-bg-muted px-2 py-0.5 text-xs font-mono text-text-muted">
									{scope.split('/').pop()}
								</span>
							{/each}
						</div>
					</div>
				{/if}
				<button
					onclick={revokeGoogle}
					disabled={revoking}
					class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/15 px-3 py-1.5 text-sm text-danger hover:bg-danger/25 disabled:opacity-50"
				>
					{revoking ? t('integrations.disconnecting') : t('integrations.disconnect')}
				</button>
			</div>
		{:else if flow}
			<!-- Device flow active -->
			<div class="space-y-3">
				<p class="text-sm text-text-muted">{t('integrations.device_flow_hint')}</p>
				<div class="rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 p-4 text-center space-y-2">
					<a href={flow.verificationUrl} target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80 text-sm break-all">
						{flow.verificationUrl}
					</a>
					<button onclick={() => copyText(flow?.userCode ?? '')} class="text-2xl font-mono font-bold text-text tracking-widest hover:text-accent-text transition-colors cursor-pointer" title={t('common.copy')}>{flow.userCode}</button>
				</div>
				<p class="text-xs text-text-subtle">{t('integrations.waiting_auth')}</p>
			</div>
		{:else}
			<!-- Credentials set, not connected -->
			<div class="space-y-2">
				<button
					onclick={startGoogleAuth}
					disabled={connecting}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
				>
					{connecting ? t('integrations.connecting') : t('integrations.connect_google')}
				</button>
				<p class="text-xs text-text-subtle">{managed ? t('integrations.redirect_flow_preview') : t('integrations.device_flow_preview')}</p>
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

	<!-- Telegram (hidden in managed — self-hosted only) -->
	{#if !managed}
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.telegram')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.telegram_desc')}</p>
			</div>
			{#if secretsLoading}
				<span class="text-xs text-text-subtle">{t('common.loading')}</span>
			{:else if telegramConfigured}
				<span class="text-xs text-success">{t('integrations.telegram_connected')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.not_configured')}</span>
			{/if}
		</div>

		{#if telegramConfigured}
			<!-- Connected state -->
			<button
				onclick={tgDisconnect}
				disabled={tgDisconnecting}
				class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/15 px-3 py-1.5 text-sm text-danger hover:bg-danger/25 disabled:opacity-50"
			>
				{tgDisconnecting ? t('integrations.telegram_disconnecting') : t('integrations.telegram_disconnect')}
			</button>

		{:else if tgStep === 'idle'}
			<!-- Not configured — show connect button -->
			<button
				onclick={() => (tgStep = 'token')}
				class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90"
			>
				{t('integrations.telegram_connect')}
			</button>

		{:else if tgStep === 'token'}
			<!-- Step 1: Enter token -->
			<div class="space-y-3">
				<ol class="text-xs text-text-muted space-y-1.5 list-decimal list-inside mb-1">
					<li>{t('integrations.telegram_step1')} <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80">@BotFather</a></li>
					<li>{t('integrations.telegram_step2')}</li>
					<li>{t('integrations.telegram_step3')}</li>
				</ol>
				<div>
					<label for="tg-token" class="block text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.telegram_token')}</label>
					<input
						id="tg-token"
						bind:value={tgToken}
						type="password"
						placeholder="123456:ABC-DEF..."
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
					/>
				</div>
				<div class="flex gap-2">
					<button
						onclick={tgValidateToken}
						disabled={!tgToken.trim() || tgValidating}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
					>
						{tgValidating ? t('integrations.telegram_validating') : t('integrations.telegram_next')}
					</button>
					<button
						onclick={tgCancel}
						class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover"
					>
						{t('common.cancel')}
					</button>
				</div>
			</div>

		{:else if tgStep === 'waiting'}
			<!-- Step 2: Waiting for message -->
			<div class="space-y-3">
				<p class="text-sm text-text-muted">
					{t('integrations.telegram_send_message')} <a href="https://t.me/{tgBotUsername}" target="_blank" rel="noopener noreferrer" class="text-accent-text font-semibold hover:opacity-80">@{tgBotUsername}</a> {t('integrations.telegram_send_message_suffix')}
				</p>
				<div class="flex items-center gap-2 text-xs text-text-subtle">
					<span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent"></span>
					{t('integrations.telegram_waiting')}
				</div>
				<button
					onclick={tgCancel}
					class="rounded-[var(--radius-sm)] border border-border px-3 py-1.5 text-sm text-text-muted hover:text-text hover:border-border-hover"
				>
					{t('common.cancel')}
				</button>
			</div>

		{:else if tgStep === 'detected'}
			<!-- Step 3: Chat ID detected -->
			<div class="space-y-3">
				<div class="rounded-[var(--radius-md)] border border-success/30 bg-success/10 p-3">
					<p class="text-sm text-success font-medium">
						&#10003; {t('integrations.telegram_detected')}: <span class="font-mono">{tgDetectedChatId}</span>
						{#if tgDetectedName}
							<span class="text-text-muted font-normal">({tgDetectedName})</span>
						{/if}
					</p>
				</div>
				<div class="flex gap-2">
					<button
						onclick={tgSaveAndFinish}
						disabled={tgSaving}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
					>
						{tgSaving ? t('settings.saving') : t('integrations.telegram_save')}
					</button>
					<button
						onclick={tgCancel}
						class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover"
					>
						{t('common.cancel')}
					</button>
				</div>
			</div>

		{:else if tgStep === 'error'}
			<!-- Error state -->
			<div class="space-y-3">
				<p class="text-sm text-danger">{tgError}</p>
				<div class="flex gap-2">
					<button
						onclick={() => { tgError = ''; tgStep = 'token'; }}
						class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90"
					>
						{t('integrations.telegram_retry')}
					</button>
					<button
						onclick={tgCancel}
						class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover"
					>
						{t('common.cancel')}
					</button>
				</div>
			</div>
		{/if}
	</div>
	{/if}

	<!-- Web Search (hidden in managed — SearXNG pre-configured) -->
	{#if !managed}
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.search')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.search_desc')}</p>
			</div>
			{#if secretsLoading}
				<span class="text-xs text-text-subtle">{t('common.loading')}</span>
			{:else if searchConfigured}
				<span class="text-xs text-success">{t('integrations.search_configured')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.search_not_configured')}</span>
			{/if}
		</div>

		{#if searchSaved}
			<p class="text-sm text-success">{t('integrations.search_saved')}</p>
		{:else}
			<div class="space-y-3">
				{#if !searchConfigured}
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
						bind:value={searchKey}
						type="password"
						placeholder="tvly-..."
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
					/>
				</div>
				<button
					onclick={saveSearch}
					disabled={!searchKey.trim() || searchSaving}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
				>
					{searchSaving ? t('settings.saving') : t('settings.save')}
				</button>
			</div>
		{/if}
	</div>
	{/if}

	<!-- SearXNG (hidden in managed — pre-configured as sidecar) -->
	{#if !managed}
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.searxng')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.searxng_desc')}</p>
			</div>
			{#if secretsLoading}
				<span class="text-xs text-text-subtle">{t('common.loading')}</span>
			{:else if searxngConfigured}
				<span class="text-xs text-success">{t('integrations.searxng_configured')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.searxng_not_configured')}</span>
			{/if}
		</div>

		{#if searxngSaved}
			<p class="text-sm text-success">{t('integrations.searxng_saved')}</p>
		{:else if searxngConfigured}
			<div class="space-y-3">
				<p class="text-xs text-text-muted font-mono">{searxngConfiguredUrl}</p>
				<div class="flex gap-2">
					<button
						onclick={() => checkSearxng(searxngConfiguredUrl)}
						disabled={searxngChecking}
						class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover disabled:opacity-50"
					>
						{searxngChecking ? t('integrations.searxng_checking') : t('integrations.searxng_check')}
					</button>
					<button
						onclick={removeSearxng}
						disabled={searxngSaving}
						class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-error hover:border-error disabled:opacity-50"
					>
						{t('integrations.searxng_remove')}
					</button>
				</div>
				{#if searxngHealthy === true}
					<p class="text-xs text-success">{t('integrations.searxng_healthy')}</p>
				{:else if searxngHealthy === false}
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
							bind:value={searxngUrl}
							type="url"
							placeholder="http://localhost:8888"
							class="flex-1 rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
						/>
						<button
							onclick={() => { if (searxngUrl.trim()) checkSearxng(searxngUrl.trim().replace(/\/+$/, '')); }}
							disabled={!searxngUrl.trim() || searxngChecking}
							class="rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover disabled:opacity-50"
						>
							{searxngChecking ? t('integrations.searxng_checking') : t('integrations.searxng_check')}
						</button>
					</div>
				</div>
				{#if searxngHealthy === true}
					<p class="text-xs text-success">{t('integrations.searxng_healthy')}</p>
				{:else if searxngHealthy === false}
					<p class="text-xs text-error">{t('integrations.searxng_check_failed')}</p>
				{/if}
				<button
					onclick={saveSearxng}
					disabled={!searxngUrl.trim() || searxngSaving}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
				>
					{searxngSaving ? t('settings.saving') : t('settings.save')}
				</button>
			</div>
		{/if}
	</div>
	{/if}
</div>
