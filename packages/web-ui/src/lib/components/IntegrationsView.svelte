<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.js';

	interface GoogleStatus {
		available: boolean;
		authenticated?: boolean;
		scopes?: string[];
		expiresAt?: string | null;
		hasRefreshToken?: boolean;
	}

	interface DeviceFlow {
		verificationUrl: string;
		userCode: string;
	}

	let status = $state<GoogleStatus | null>(null);
	let loading = $state(true);
	let flow = $state<DeviceFlow | null>(null);
	let connecting = $state(false);
	let revoking = $state(false);

	async function loadStatus() {
		loading = true;
		const res = await fetch(`${getApiBase()}/google/status`);
		status = (await res.json()) as GoogleStatus;
		loading = false;
	}

	async function startAuth() {
		connecting = true;
		flow = null;
		const res = await fetch(`${getApiBase()}/google/auth`, { method: 'POST' });
		if (res.ok) {
			flow = (await res.json()) as DeviceFlow;
		}
		connecting = false;
		const interval = setInterval(async () => {
			const r = await fetch(`${getApiBase()}/google/status`);
			const s = (await r.json()) as GoogleStatus;
			if (s.authenticated) {
				status = s;
				flow = null;
				clearInterval(interval);
			}
		}, 3000);
		setTimeout(() => clearInterval(interval), 5 * 60_000);
	}

	async function revoke() {
		revoking = true;
		await fetch(`${getApiBase()}/google/revoke`, { method: 'POST' });
		revoking = false;
		await loadStatus();
	}

	$effect(() => {
		loadStatus();
	});
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 class="text-xl font-light tracking-tight mb-6">{t('integrations.title')}</h1>

	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-5">
		<div class="flex items-center justify-between mb-4">
			<div>
				<h2 class="font-medium">{t('integrations.google_workspace')}</h2>
				<p class="text-xs text-text-muted mt-1">{t('integrations.google_services')}</p>
			</div>
			{#if loading}
				<span class="text-xs text-text-subtle">{t('common.loading')}</span>
			{:else if status?.authenticated}
				<span class="text-xs text-success">{t('integrations.connected')}</span>
			{:else if status?.available}
				<span class="text-xs text-text-subtle">{t('integrations.not_connected')}</span>
			{:else}
				<span class="text-xs text-text-subtle">{t('integrations.not_configured')}</span>
			{/if}
		</div>

		{#if loading}
			<!-- loading -->
		{:else if !status?.available}
			<p class="text-sm text-text-muted">
				{t('integrations.oauth_not_configured')}
			</p>
		{:else if status.authenticated}
			<div class="space-y-3">
				{#if status.scopes && status.scopes.length > 0}
					<div>
						<p class="text-xs font-mono uppercase tracking-widest text-text-subtle mb-1">{t('integrations.permissions')}</p>
						<div class="flex flex-wrap gap-1">
							{#each status.scopes as scope}
								<span class="rounded-[var(--radius-sm)] bg-bg-muted px-2 py-0.5 text-xs font-mono text-text-muted">
									{scope.split('/').pop()}
								</span>
							{/each}
						</div>
					</div>
				{/if}
				<button
					onclick={revoke}
					disabled={revoking}
					class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/15 px-3 py-1.5 text-sm text-danger hover:bg-danger/25 disabled:opacity-50"
				>
					{revoking ? t('integrations.disconnecting') : t('integrations.disconnect')}
				</button>
			</div>
		{:else if flow}
			<div class="space-y-3">
				<p class="text-sm text-text-muted">
					{t('integrations.device_flow_hint')}
				</p>
				<div class="rounded-[var(--radius-md)] border border-accent/30 bg-accent/5 p-4 text-center space-y-2">
					<a
						href={flow.verificationUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="text-accent-text hover:opacity-80 text-sm break-all"
					>
						{flow.verificationUrl}
					</a>
					<p class="text-2xl font-mono font-bold text-text tracking-widest">{flow.userCode}</p>
				</div>
				<p class="text-xs text-text-subtle">{t('integrations.waiting_auth')}</p>
			</div>
		{:else}
			<button
				onclick={startAuth}
				disabled={connecting}
				class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm text-text hover:opacity-90 disabled:opacity-50"
			>
				{connecting ? t('integrations.connecting') : t('integrations.connect_google')}
			</button>
		{/if}
	</div>
</div>
