<!--
	System Settings — vault + access token + update check.
	PRD-SETTINGS-REFACTOR Phase 5 (slimmed from old ConfigView System tab).
	Self-host / BYOK only; managed shows a minimal "managed" notice.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface Config {
		update_check?: boolean;
		managed?: string;
	}

	let config = $state<Config>({});
	let managed = $state(false);
	let loaded = $state(false);
	let saving = $state(false);

	let vaultConfigured = $state(false);
	let vaultRevealed = $state(false);
	let vaultKey = $state<string | null>(null);

	let accessTokenRevealed = $state(false);
	let accessToken = $state<string | null>(null);

	async function load(): Promise<void> {
		try {
			const [configRes, vaultRes] = await Promise.all([
				fetch(`${getApiBase()}/config`),
				fetch(`${getApiBase()}/vault/key?reveal=false`),
			]);
			if (!configRes.ok) throw new Error(`HTTP ${configRes.status}`);
			const body = (await configRes.json()) as Config;
			config = { update_check: body.update_check };
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
			if (vaultRes.ok) {
				const vaultBody = (await vaultRes.json()) as { configured: boolean };
				vaultConfigured = vaultBody.configured;
			}
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('system.load_failed'), 'error', 5000);
		}
	}

	async function revealVault(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/vault/key?reveal=true`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { key: string | null };
			vaultKey = body.key;
			vaultRevealed = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('system.vault_failed'), 'error', 5000);
		}
	}

	async function revealAccessToken(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/access-token`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { token: string | null };
			accessToken = body.token;
			accessTokenRevealed = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('system.token_failed'), 'error', 5000);
		}
	}

	async function saveUpdateCheck(): Promise<void> {
		saving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ update_check: config.update_check }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('system.saved'), 'success', 3000);
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('system.save_failed'), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	$effect(() => { void load(); });
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('system.title')}</h1>
		<p class="text-sm text-text-muted">{t('system.subtitle')}</p>
	</header>

	{#if managed}
		<section class="border border-border rounded p-4 text-sm text-text-muted">
			<p>{t('system.managed_minimal')}</p>
		</section>
	{:else if !loaded}
		<p class="text-sm text-text-muted">{t('system.loading')}</p>
	{:else}
		<!-- Vault key (self-host only) -->
		<section class="border-t border-border pt-6 space-y-2">
			<h2 class="text-lg font-medium">{t('system.vault_heading')}</h2>
			<p class="text-xs text-text-muted">{t('system.vault_subtitle')}</p>
			{#if !vaultConfigured}
				<p class="text-sm italic text-text-muted">{t('system.vault_not_configured')}</p>
			{:else if vaultRevealed && vaultKey}
				<pre class="font-mono text-xs px-2 py-1 bg-bg-muted rounded select-all overflow-x-auto">{vaultKey}</pre>
				<p class="text-xs text-warning">{t('system.vault_reveal_warning')}</p>
			{:else}
				<button type="button" onclick={revealVault}
					class="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent/5">
					{t('system.vault_reveal')}
				</button>
			{/if}
		</section>

		<!-- Access token -->
		<section class="border-t border-border pt-6 space-y-2">
			<h2 class="text-lg font-medium">{t('system.token_heading')}</h2>
			<p class="text-xs text-text-muted">{t('system.token_subtitle')}</p>
			{#if accessTokenRevealed && accessToken}
				<pre class="font-mono text-xs px-2 py-1 bg-bg-muted rounded select-all overflow-x-auto">{accessToken}</pre>
				<p class="text-xs text-warning">{t('system.token_reveal_warning')}</p>
			{:else}
				<button type="button" onclick={revealAccessToken}
					class="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent/5">
					{t('system.token_reveal')}
				</button>
			{/if}
		</section>

		<!-- Update check -->
		<section class="border-t border-border pt-6 space-y-2">
			<h2 class="text-lg font-medium">{t('system.update_heading')}</h2>
			<p class="text-xs text-text-muted">{t('system.update_subtitle')}</p>
			<label class="flex items-center gap-2 cursor-pointer">
				<input type="checkbox" disabled={saving} bind:checked={config.update_check}
					onchange={saveUpdateCheck} class="w-4 h-4" />
				<span class="text-sm">{t('system.update_label')}</span>
			</label>
		</section>
	{/if}
</div>
