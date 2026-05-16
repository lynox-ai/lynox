<!--
	Workspace Limits (PRD-IA-V2 P3-PR-B) — Self-Host only. Managed pool is
	CP-gated. CostLimits.svelte stays live with deprecation banner until
	P3-PR-X deletes it; both surfaces PUT the same fields to /api/config
	(backend SSoT), so a stale tab cannot drift state.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';

	interface UserConfig {
		max_monthly_cost_usd?: number;
		max_daily_cost_usd?: number;
		max_session_cost_usd?: number;
		max_http_requests_per_hour?: number;
	}

	let config = $state<UserConfig>({});
	let managed = $state(false);
	let loaded = $state(false);
	let saving = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as UserConfig & { managed?: string };
			// Narrow to the 4 fields this surface owns — preserves type safety
			// and avoids stomping unrelated config on save.
			config = {
				max_monthly_cost_usd: body.max_monthly_cost_usd,
				max_daily_cost_usd: body.max_daily_cost_usd,
				max_session_cost_usd: body.max_session_cost_usd,
				max_http_requests_per_hour: body.max_http_requests_per_hour,
			};
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('cost_limits.load_failed'), 'error', 5000);
		}
	}

	async function save(): Promise<void> {
		if (!loaded) return;
		// Drop the HTTP rate-cap entirely when blank/zero so the engine falls back
		// to its built-in default (200/hr) rather than persisting a 0-cap that
		// would brick every HTTP-tool call. Same defensive pattern as
		// SystemSettings.saveHttpRateLimit() pre-extraction.
		const raw = config.max_http_requests_per_hour;
		const httpCap: { max_http_requests_per_hour?: number } = {};
		if (typeof raw === 'number' && raw > 0 && Number.isFinite(raw)) {
			httpCap.max_http_requests_per_hour = Math.floor(raw);
		}
		saving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					max_monthly_cost_usd: config.max_monthly_cost_usd,
					max_daily_cost_usd: config.max_daily_cost_usd,
					max_session_cost_usd: config.max_session_cost_usd,
					...httpCap,
				}),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			addToast(t('cost_limits.saved'), 'success', 3000);
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('cost_limits.save_failed'), 'error', 5000);
		} finally {
			saving = false;
		}
	}

	$effect(() => { void load(); });
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('settings.workspace.limits')}</h1>
		<p class="text-sm text-text-muted">{t('settings.workspace.limits_desc')}</p>
	</header>

	{#if managed}
		<section class="border border-border rounded p-4 text-sm text-text-muted">
			<p>{t('cost_limits.hard.managed_notice')}
				<a href="mailto:support@lynox.ai" class="text-accent-text underline">support@lynox.ai</a>
			</p>
		</section>
	{:else if !loaded}
		<p class="text-sm text-text-muted">{t('cost_limits.loading')}</p>
	{:else}
		<!-- Spend limits -->
		<section aria-labelledby="wl-spend-heading" class="border-t border-border pt-6">
			<h2 id="wl-spend-heading" class="text-lg font-medium mb-1">{t('settings.workspace.limits.spend_heading')}</h2>
			<p class="text-xs text-text-muted mb-3">{t('settings.workspace.limits.spend_subtitle')}</p>
			<div class="grid gap-4 sm:grid-cols-3">
				<label class="block">
					<span class="block text-sm mb-1">{t('config.monthly_limit')}</span>
					<input type="number" step="1" min="0" placeholder="—" disabled={!loaded}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50"
						bind:value={config.max_monthly_cost_usd} />
				</label>
				<label class="block">
					<span class="block text-sm mb-1">{t('config.daily_limit')}</span>
					<input type="number" step="0.5" min="0" placeholder="—" disabled={!loaded}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50"
						bind:value={config.max_daily_cost_usd} />
				</label>
				<label class="block">
					<span class="block text-sm mb-1">{t('config.session_limit')}</span>
					<input type="number" step="0.5" min="0" placeholder="5.00" disabled={!loaded}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50"
						bind:value={config.max_session_cost_usd} />
				</label>
			</div>
		</section>

		<!-- HTTP rate cap -->
		<section aria-labelledby="wl-http-heading" class="border-t border-border pt-6">
			<h2 id="wl-http-heading" class="text-lg font-medium mb-1">{t('system.http_rate_heading')}</h2>
			<p class="text-xs text-text-muted mb-3">{t('config.http_rate_limit_desc')}</p>
			<label class="block max-w-xs">
				<span class="block text-sm mb-1">{t('config.http_rate_limit')}</span>
				<input type="number" min="1" max="100000" step="1" placeholder="200"
					bind:value={config.max_http_requests_per_hour}
					disabled={!loaded}
					class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50" />
			</label>
		</section>

		<!-- Save row -->
		<div class="flex justify-end pt-2">
			<button type="button" onclick={save} disabled={saving || !loaded}
				class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
				{saving ? t('cost_limits.saving') : t('cost_limits.save')}
			</button>
		</div>
	{/if}
</div>
