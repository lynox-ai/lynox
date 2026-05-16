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
		// PRD-IA-V2 P1-PR-A1 — backfill the legacy ConfigView HTTP-rate-cap
		// here as a temporary home; final SSoT lands on `/workspace/limits`
		// in P3-PR-B. Self-host only — managed tier hides the input below.
		max_http_requests_per_hour?: number;
	}

	let config = $state<Config>({});
	let managed = $state(false);
	let loaded = $state(false);
	let saving = $state(false);
	let httpRateSaving = $state(false);

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
			config = {
				update_check: body.update_check,
				max_http_requests_per_hour: body.max_http_requests_per_hour,
			};
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

	async function saveHttpRateLimit(): Promise<void> {
		// Drop the field entirely when blank/zero so the engine falls back to
		// its built-in default (200/hr) rather than persisting a 0-cap that
		// would brick all HTTP-tool calls.
		const raw = config.max_http_requests_per_hour;
		const payload: { max_http_requests_per_hour?: number } = {};
		if (typeof raw === 'number' && raw > 0 && Number.isFinite(raw)) {
			payload.max_http_requests_per_hour = Math.floor(raw);
		}
		httpRateSaving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('system.saved'), 'success', 3000);
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('system.save_failed'), 'error', 5000);
		} finally {
			httpRateSaving = false;
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

		<!--
			HTTP rate cap — temporary home per PRD-IA-V2 P1-PR-A1 (final SSoT:
			`/settings/workspace/limits` in P3-PR-B). Surfaced here only on
			self-host because (a) the input is non-monetary and (b) the legacy
			ConfigView gated it on `!managed`.
		-->
		<section class="border-t border-border pt-6 space-y-2">
			<h2 class="text-lg font-medium">{t('system.http_rate_heading')}</h2>
			<p class="text-xs text-text-muted">{t('config.http_rate_limit_desc')}</p>
			<div class="flex items-end gap-2">
				<label class="flex-1">
					<span class="block text-sm font-medium mb-1">{t('config.http_rate_limit')}</span>
					<input type="number" min="1" max="100000" step="1" placeholder="200"
						bind:value={config.max_http_requests_per_hour}
						disabled={httpRateSaving}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
				</label>
				<button type="button" onclick={saveHttpRateLimit}
					disabled={httpRateSaving}
					class="px-3 py-1.5 text-sm border border-border rounded hover:bg-accent/5 disabled:opacity-50">
					{httpRateSaving ? t('system.saving') : t('system.save_button')}
				</button>
			</div>
			<p class="text-xs text-text-muted italic">{t('system.http_rate_temp_home')}</p>
		</section>
	{/if}
</div>
