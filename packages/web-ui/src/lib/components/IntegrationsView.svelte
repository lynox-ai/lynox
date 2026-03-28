<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

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
		if (!googleClientId.trim() || !googleClientSecret.trim()) return;
		googleCredSaving = true;
		try {
			const [r1, r2] = await Promise.all([
				fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_ID`, {
					method: 'PUT', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ value: googleClientId })
				}),
				fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_SECRET`, {
					method: 'PUT', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ value: googleClientSecret })
				}),
			]);
			if (!r1.ok || !r2.ok) throw new Error();
			googleClientId = '';
			googleClientSecret = '';
			googleCredSaved = true;
			setTimeout(() => (googleCredSaved = false), 2000);
			await loadGoogleStatus();
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
			const res = await fetch(`${getApiBase()}/google/auth`, { method: 'POST' });
			if (res.ok) { flow = (await res.json()) as DeviceFlow; }
		} catch { /* ignore */ }
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

	// --- Telegram ---
	let telegramToken = $state('');
	let telegramChatId = $state('');
	let telegramSaving = $state(false);
	let telegramSaved = $state(false);
	let telegramConfigured = $state(false);

	// --- Web Search ---
	let searchKey = $state('');
	let searchSaving = $state(false);
	let searchSaved = $state(false);
	let searchConfigured = $state(false);

	let secretsLoading = $state(true);

	async function loadSecretStatuses() {
		secretsLoading = true;
		try {
			const res = await fetch(`${getApiBase()}/secrets`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { names: string[] };
			telegramConfigured = data.names.includes('TELEGRAM_BOT_TOKEN');
			searchConfigured = data.names.includes('TAVILY_API_KEY') || data.names.includes('SEARCH_API_KEY');
		} catch { /* ignore */ }
		secretsLoading = false;
	}

	async function saveTelegram() {
		if (!telegramToken.trim()) return;
		telegramSaving = true;
		try {
			const res = await fetch(`${getApiBase()}/secrets/TELEGRAM_BOT_TOKEN`, {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: telegramToken })
			});
			if (!res.ok) throw new Error();
			if (telegramChatId.trim()) {
				const r2 = await fetch(`${getApiBase()}/secrets/TELEGRAM_ALLOWED_CHAT_IDS`, {
					method: 'PUT', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ value: telegramChatId })
				});
				if (!r2.ok) throw new Error();
			}
			telegramToken = '';
			telegramChatId = '';
			telegramSaved = true;
			setTimeout(() => (telegramSaved = false), 2000);
			await loadSecretStatuses();
		} catch {
			addToast(t('common.save_failed'), 'error');
		}
		telegramSaving = false;
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

	// Load all statuses on mount
	import { onDestroy } from 'svelte';

	$effect(() => {
		loadGoogleStatus();
		loadSecretStatuses();
	});

	onDestroy(() => {
		if (authPollInterval) { clearInterval(authPollInterval); authPollInterval = null; }
	});
</script>

<div class="p-6 max-w-4xl mx-auto space-y-4">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-6 mt-2">{t('integrations.title')}</h1>

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
		{:else if !googleStatus?.available}
			<!-- Credentials not set — show input -->
			<div class="space-y-3">
				{#if googleCredSaved}
					<p class="text-sm text-success">{t('integrations.credentials_saved')}</p>
				{:else}
					<p class="text-xs text-text-muted mb-2">
						{t('integrations.credentials_hint')} <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80">Google Cloud Console</a>
					</p>
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
			<button
				onclick={startGoogleAuth}
				disabled={connecting}
				class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
			>
				{connecting ? t('integrations.connecting') : t('integrations.connect_google')}
			</button>
		{/if}
	</div>

	<!-- Telegram -->
	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.telegram')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.telegram_desc')}</p>
			</div>
			{#if secretsLoading}
				<span class="text-xs text-text-subtle">{t('common.loading')}</span>
			{:else if telegramConfigured}
				<span class="text-xs text-success">{t('integrations.telegram_configured')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.not_configured')}</span>
			{/if}
		</div>

		{#if telegramSaved}
			<p class="text-sm text-success">{t('integrations.telegram_saved')}</p>
		{:else}
			<div class="space-y-3">
				<div>
					<label for="tg-token" class="block text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.telegram_token')}</label>
					<input
						id="tg-token"
						bind:value={telegramToken}
						type="password"
						placeholder="123456:ABC-DEF..."
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
					/>
					<p class="text-xs text-text-subtle mt-1">
						{t('integrations.telegram_token_hint')} <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80">@BotFather</a>
					</p>
				</div>
				<div>
					<label for="tg-chat" class="block text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.telegram_chat_id')}</label>
					<input
						id="tg-chat"
						bind:value={telegramChatId}
						placeholder="123456789"
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
					/>
					<p class="text-xs text-text-subtle mt-1">
						{t('integrations.telegram_chat_id_hint')} <code class="text-accent-text">https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code>
					</p>
				</div>
				<button
					onclick={saveTelegram}
					disabled={!telegramToken.trim() || telegramSaving}
					class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
				>
					{telegramSaving ? t('settings.saving') : t('integrations.telegram_save')}
				</button>
			</div>
		{/if}
	</div>

	<!-- Web Search -->
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
				<div>
					<label for="search-key" class="block text-xs font-mono uppercase tracking-widest text-text-subtle mb-1.5">{t('integrations.tavily_label')}</label>
					<input
						id="search-key"
						bind:value={searchKey}
						type="password"
						placeholder="tvly-..."
						class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm font-mono outline-none focus:border-border-hover"
					/>
					<p class="text-xs text-text-subtle mt-1">
						{t('integrations.search_key_hint')} <a href="https://tavily.com" target="_blank" rel="noopener noreferrer" class="text-accent-text hover:opacity-80">tavily.com</a>
					</p>
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
</div>
