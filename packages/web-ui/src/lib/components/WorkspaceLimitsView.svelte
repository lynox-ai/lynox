<!--
	Workspace Limits (PRD-IA-V2 P3-PR-B) — Final canonical home for spend-limits +
	HTTP-rate-cap after P3-PR-X deleted CostLimits.svelte. Backend SSoT is
	`/api/config` (PUT). Legacy URL `/app/hub/cost-limits` 301-redirects here.

	Settings v3 PR 3 (Items 8/9/11, 2026-05-19):
	- Effective-limits pills row always shown (Item 11 — transparency).
	- Managed tier renders the editable inputs grayed-with-tooltip instead of
	  hidden (Item 8 — show-all-grayed pattern). The "contact support" CTA
	  remains below the inputs as the actionable path.
	- Hard limits (spawn caps, HTTP-tool caps, default context window) sourced
	  from /api/config.capabilities.hard_limits (Item 9 — read-only pills).

	Tier-awareness audit:
	| Setting                | Self-host | BYOK | Managed |
	|------------------------|-----------|------|---------|
	| max_*_cost_usd         | ✓ edit    | ✓ edit | ✗ grayed + CTA |
	| max_http_requests_per_hour | ✓ edit | ✓ edit | ✗ grayed + CTA |
	| Effective-limits pills | ✓ pills   | ✓ pills | ✓ tier-label pill |
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { formatContextWindow } from '../utils/context-window.js';

	interface UserConfig {
		max_monthly_cost_usd?: number;
		max_daily_cost_usd?: number;
		max_session_cost_usd?: number;
		max_http_requests_per_hour?: number;
	}

	// Subset of /api/config.capabilities.hard_limits surfaced to the UI.
	// Self-host/BYOK → numeric. Managed → tier-tag + contact_for_quotas only.
	interface HardLimitsNumeric {
		per_spawn_cents: number;
		max_per_spawn_cents: number;
		spawn_max_turns: number;
		spawn_max_agents_per_call: number;
		spawn_max_depth: number;
		tool_http_per_hour: number;
		tool_http_per_day: number;
		default_context_window_tokens: number;
	}
	interface HardLimitsManaged {
		tier: 'managed';
		contact_for_quotas: true;
	}
	type HardLimits = HardLimitsNumeric | HardLimitsManaged;

	function isManagedLimits(h: HardLimits | null): h is HardLimitsManaged {
		return h !== null && 'tier' in h && h.tier === 'managed';
	}

	let config = $state<UserConfig>({});
	let hardLimits = $state<HardLimits | null>(null);
	let managed = $state(false);
	let loaded = $state(false);
	let saving = $state(false);

	async function load(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/config`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as UserConfig & {
				managed?: string;
				capabilities?: { hard_limits?: HardLimits };
			};
			// Narrow to the 4 fields this surface owns — preserves type safety
			// and avoids stomping unrelated config on save.
			config = {
				max_monthly_cost_usd: body.max_monthly_cost_usd,
				max_daily_cost_usd: body.max_daily_cost_usd,
				max_session_cost_usd: body.max_session_cost_usd,
				max_http_requests_per_hour: body.max_http_requests_per_hour,
			};
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
			hardLimits = body.capabilities?.hard_limits ?? null;
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('cost_limits.load_failed'), 'error', 5000);
		}
	}

	async function save(): Promise<void> {
		if (!loaded) return;
		// Drop the HTTP rate-cap entirely when blank/zero so the engine falls back
		// to its built-in default (200/hr) rather than persisting a 0-cap that
		// would brick every HTTP-tool call.
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
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('account.back_to_settings')}</a>
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('settings.workspace.limits')}</h1>
		<p class="text-sm text-text-muted">{t('settings.workspace.limits_desc')}</p>
	</header>

	{#if !loaded}
		<p class="text-sm text-text-muted">{t('cost_limits.loading')}</p>
	{:else}
		<!-- Item 9/11: Effective-limits pills row. Self-host/BYOK pills carry
		     numeric caps from getHardLimits(); managed renders a tier-tag pill
		     since the CP enforces per-customer caps not exposed here. Section
		     suppressed entirely when hard_limits is missing (older engine) so
		     we don't render a heading over an empty row. -->
		{#if hardLimits}
			<section aria-labelledby="wl-pills-heading" class="space-y-2">
				<h2 id="wl-pills-heading" class="text-sm font-medium text-text-muted">
					{t('settings.workspace.limits.effective_heading')}
				</h2>
				<div class="flex flex-wrap gap-2 text-xs">
					{#if !isManagedLimits(hardLimits)}
						<span class="rounded border border-border bg-bg-subtle px-2 py-1">
							<span class="text-text-muted">{t('settings.workspace.limits.pill_spawn_budget')}:</span>
							<span class="font-mono">${(hardLimits.per_spawn_cents / 100).toFixed(2)} – ${(hardLimits.max_per_spawn_cents / 100).toFixed(2)}</span>
						</span>
						<span class="rounded border border-border bg-bg-subtle px-2 py-1">
							<span class="text-text-muted">{t('settings.workspace.limits.pill_spawn_turns')}:</span>
							<span class="font-mono">{hardLimits.spawn_max_turns}</span>
						</span>
						<span class="rounded border border-border bg-bg-subtle px-2 py-1">
							<span class="text-text-muted">{t('settings.workspace.limits.pill_spawn_depth')}:</span>
							<span class="font-mono">{hardLimits.spawn_max_depth}</span>
						</span>
						<span class="rounded border border-border bg-bg-subtle px-2 py-1">
							<span class="text-text-muted">{t('settings.workspace.limits.pill_http_hour')}:</span>
							<span class="font-mono">{hardLimits.tool_http_per_hour}/h</span>
						</span>
						<span class="rounded border border-border bg-bg-subtle px-2 py-1">
							<span class="text-text-muted">{t('settings.workspace.limits.pill_http_day')}:</span>
							<span class="font-mono">{hardLimits.tool_http_per_day}/d</span>
						</span>
						<span class="rounded border border-border bg-bg-subtle px-2 py-1">
							<span class="text-text-muted">{t('settings.workspace.limits.pill_ctx_default')}:</span>
							<span class="font-mono">{formatContextWindow(hardLimits.default_context_window_tokens)}</span>
						</span>
					{:else}
						<span class="rounded border border-accent/40 bg-accent/5 px-2 py-1">
							<span class="text-text-muted">{t('settings.workspace.limits.pill_tier')}:</span>
							<span class="font-mono">{hardLimits.tier}</span>
						</span>
						<span class="text-text-muted self-center">{t('settings.workspace.limits.pill_managed_note')}</span>
					{/if}
				</div>
			</section>
		{/if}

		<!-- Spend limits — Item 8: grayed on managed (with tooltip) instead of
		     hidden. Inputs always rendered so the user can see what's gated. -->
		<section aria-labelledby="wl-spend-heading" class="border-t border-border pt-6">
			<h2 id="wl-spend-heading" class="text-lg font-medium mb-1">{t('settings.workspace.limits.spend_heading')}</h2>
			<p class="text-xs text-text-muted mb-3">{t('settings.workspace.limits.spend_subtitle')}</p>
			<div class="grid gap-4 sm:grid-cols-3">
				<label class="block" title={managed ? t('settings.workspace.limits.disabled_managed_tooltip') : undefined}>
					<span class="block text-sm mb-1">{t('config.monthly_limit')}</span>
					<input type="number" step="1" min="0" placeholder="—" disabled={!loaded || managed}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50 disabled:cursor-not-allowed"
						bind:value={config.max_monthly_cost_usd} />
				</label>
				<label class="block" title={managed ? t('settings.workspace.limits.disabled_managed_tooltip') : undefined}>
					<span class="block text-sm mb-1">{t('config.daily_limit')}</span>
					<input type="number" step="0.5" min="0" placeholder="—" disabled={!loaded || managed}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50 disabled:cursor-not-allowed"
						bind:value={config.max_daily_cost_usd} />
				</label>
				<label class="block" title={managed ? t('settings.workspace.limits.disabled_managed_tooltip') : undefined}>
					<span class="block text-sm mb-1">{t('config.session_limit')}</span>
					<input type="number" step="0.5" min="0" placeholder="5.00" disabled={!loaded || managed}
						class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50 disabled:cursor-not-allowed"
						bind:value={config.max_session_cost_usd} />
				</label>
			</div>
		</section>

		<!-- HTTP rate cap — Item 8: same grayed pattern. -->
		<section aria-labelledby="wl-http-heading" class="border-t border-border pt-6">
			<h2 id="wl-http-heading" class="text-lg font-medium mb-1">{t('system.http_rate_heading')}</h2>
			<p class="text-xs text-text-muted mb-3">{t('config.http_rate_limit_desc')}</p>
			<label class="block max-w-xs" title={managed ? t('settings.workspace.limits.disabled_managed_tooltip') : undefined}>
				<span class="block text-sm mb-1">{t('config.http_rate_limit')}</span>
				<input type="number" min="1" max="100000" step="1" placeholder="200"
					bind:value={config.max_http_requests_per_hour}
					disabled={!loaded || managed}
					class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50 disabled:cursor-not-allowed" />
			</label>
		</section>

		{#if managed}
			<!-- Item 8: managed tier needs an actionable path even though inputs
			     are disabled. Replaces the pre-PR3 "managed notice hides everything"
			     pattern with "show grayed + actionable CTA below". -->
			<section class="border-t border-border pt-6 text-sm text-text-muted">
				<p>{t('cost_limits.hard.managed_notice')}
					<a href="mailto:support@lynox.ai" class="text-accent-text underline">support@lynox.ai</a>
				</p>
			</section>
		{:else}
			<!-- Save row — self-host/BYOK only. -->
			<div class="flex justify-end pt-2">
				<button type="button" onclick={save} disabled={saving || !loaded}
					class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
					{saving ? t('cost_limits.saving') : t('cost_limits.save')}
				</button>
			</div>
		{/if}
	{/if}
</div>
