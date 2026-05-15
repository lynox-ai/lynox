<!--
	Cost & Limits — Activity Hub canonical SSoT for cost + usage + limits.
	PRD-SETTINGS-REFACTOR Phase 1. Replaces the split between Settings/Budget
	(where users SET limits) and the old Usage tab (where they SAW spend).

	Reads GET /api/usage/current. Hard-limits panel reflects the system caps
	exposed via capabilities.hard_limits — full numeric on self-host/BYOK,
	opaque tier-tag on managed (no DoS-knob disclosure).
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import UsageDashboard from './UsageDashboard.svelte';

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
	interface HardLimitsManaged { tier: 'managed'; contact_for_quotas: true }
	type HardLimits = HardLimitsNumeric | HardLimitsManaged;

	interface UsageCurrent {
		tier: string | null;
		hard_limits: HardLimits;
		projection: { exhaust_eta_iso: string | null; projection_basis_days: number } | null;
		limit_cents: number | null;
		used_cents: number;
	}

	interface UserConfig {
		max_monthly_cost_usd?: number;
		max_daily_cost_usd?: number;
		max_session_cost_usd?: number;
		max_context_window_tokens?: number;
	}

	let usage = $state<UsageCurrent | null>(null);
	let config = $state<UserConfig>({});
	let saving = $state(false);
	let loaded = $state(false);
	let managed = $state<boolean | null>(null);

	// Plain type-guard (not $derived — no reactive deps; calling overhead-free).
	function isNumericHardLimits(h: HardLimits | undefined): h is HardLimitsNumeric {
		return !!h && 'per_spawn_cents' in h;
	}

	async function load(): Promise<void> {
		try {
			const [usageRes, configRes] = await Promise.all([
				fetch(`${getApiBase()}/usage/current`),
				fetch(`${getApiBase()}/config`),
			]);
			if (!usageRes.ok || !configRes.ok) throw new Error(`HTTP ${usageRes.status} / ${configRes.status}`);
			usage = (await usageRes.json()) as UsageCurrent;
			const body = (await configRes.json()) as UserConfig & { managed?: string };
			// Narrow to the 4 fields this surface owns — preserves type safety
			// across spread + avoids stomping unrelated config on save.
			config = {
				max_monthly_cost_usd: body.max_monthly_cost_usd,
				max_daily_cost_usd: body.max_daily_cost_usd,
				max_session_cost_usd: body.max_session_cost_usd,
				max_context_window_tokens: body.max_context_window_tokens,
			};
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
			loaded = true;
		} catch (e) {
			addToast(e instanceof Error ? e.message : t('cost_limits.load_failed'), 'error', 5000);
		}
	}

	async function saveConfig(): Promise<void> {
		if (!loaded) return;
		saving = true;
		try {
			const res = await fetch(`${getApiBase()}/config`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					max_monthly_cost_usd: config.max_monthly_cost_usd,
					max_daily_cost_usd: config.max_daily_cost_usd,
					max_session_cost_usd: config.max_session_cost_usd,
					max_context_window_tokens: config.max_context_window_tokens,
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

	const projectionLabel = $derived.by(() => {
		if (!usage?.projection?.exhaust_eta_iso) return '';
		const eta = new Date(usage.projection.exhaust_eta_iso);
		// Math.ceil so a sub-day ETA never shows "exhausts in 0 days" — the
		// projection itself is a warning, not a calendar-precise prediction.
		const days = Math.max(1, Math.ceil((eta.getTime() - Date.now()) / 86_400_000));
		return t('cost_limits.projection').replace('{days}', days.toString());
	});

	// Context window: undefined = model default; 200k / 500k / 1M = explicit caps.
	const CONTEXT_OPTIONS: ReadonlyArray<{ value: number | undefined; label: string; hint: string }> = [
		{ value: undefined,  label: t('cost_limits.context.default'),  hint: t('cost_limits.context.default_hint') },
		{ value: 200_000,    label: t('cost_limits.context.standard'), hint: t('cost_limits.context.standard_hint') },
		{ value: 500_000,    label: t('cost_limits.context.extended'), hint: t('cost_limits.context.extended_hint') },
		{ value: 1_000_000,  label: t('cost_limits.context.maximum'),  hint: t('cost_limits.context.maximum_hint') },
	];
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('cost_limits.title')}</h1>
		<p class="text-sm text-text-muted">{t('cost_limits.subtitle')}</p>
		{#if projectionLabel}
			<p class="text-xs text-warning mt-2" role="status" aria-live="polite">⚠ {projectionLabel}</p>
		{/if}
	</header>

	<!-- Usage view (reuses existing dashboard component) -->
	<section aria-labelledby="cl-usage-heading">
		<h2 id="cl-usage-heading" class="sr-only">{t('cost_limits.usage_heading')}</h2>
		<UsageDashboard />
	</section>

	{#if !managed}
		<!-- Editable limits (Self-Host / BYOK only) -->
		<section aria-labelledby="cl-limits-heading" class="border-t border-border pt-6">
			<h2 id="cl-limits-heading" class="text-lg font-medium mb-3">{t('cost_limits.limits_heading')}</h2>
			<div class="grid gap-4 sm:grid-cols-3">
				<label class="block">
					<span class="block text-sm mb-1">{t('config.monthly_limit')}</span>
					<input type="number" step="1" min="0" placeholder="—" disabled={!loaded} class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50"
						bind:value={config.max_monthly_cost_usd} />
				</label>
				<label class="block">
					<span class="block text-sm mb-1">{t('config.daily_limit')}</span>
					<input type="number" step="0.5" min="0" placeholder="—" disabled={!loaded} class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50"
						bind:value={config.max_daily_cost_usd} />
				</label>
				<label class="block">
					<span class="block text-sm mb-1">{t('config.session_limit')}</span>
					<input type="number" step="0.5" min="0" placeholder="5.00" disabled={!loaded} class="w-full font-mono px-2 py-1 border border-border rounded bg-bg disabled:opacity-50"
						bind:value={config.max_session_cost_usd} />
				</label>
			</div>
		</section>
	{/if}

	<!-- Context window — editable on every tier per PRD capability.can_set_context_window -->
	<section aria-labelledby="cl-context-heading" class="border-t border-border pt-6">
		<h2 id="cl-context-heading" class="text-lg font-medium mb-1">{t('cost_limits.context.heading')}</h2>
		<p class="text-xs text-text-muted mb-3">{t('cost_limits.context.subtitle')}</p>
		<div class="space-y-2">
			{#each CONTEXT_OPTIONS as opt (opt.value ?? 'default')}
				<label class="flex items-start gap-3 cursor-pointer">
					<input type="radio" name="context-window" value={opt.value} bind:group={config.max_context_window_tokens}
						disabled={!loaded} class="mt-1 disabled:opacity-50" />
					<div class="flex-1">
						<div class="text-sm font-medium">{opt.label}</div>
						<div class="text-xs text-text-muted">{opt.hint}</div>
					</div>
				</label>
			{/each}
		</div>
	</section>

	<!-- Save row -->
	<div class="flex justify-end">
		<button type="button" onclick={saveConfig} disabled={saving || !loaded}
			class="px-4 py-2 bg-accent text-accent-fg rounded hover:opacity-90 disabled:opacity-50">
			{saving ? t('cost_limits.saving') : t('cost_limits.save')}
		</button>
	</div>

	<!-- Hard limits (read-only system caps) -->
	<section aria-labelledby="cl-hard-heading" class="border-t border-border pt-6">
		<h2 id="cl-hard-heading" class="text-lg font-medium mb-1">{t('cost_limits.hard_heading')}</h2>
		<p class="text-xs text-text-muted mb-3">{t('cost_limits.hard_subtitle')}</p>
		{#if usage?.hard_limits && isNumericHardLimits(usage.hard_limits)}
			<dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
				<dt class="text-text-muted">{t('cost_limits.hard.per_spawn')}</dt>
				<dd class="font-mono">${(usage.hard_limits.per_spawn_cents / 100).toFixed(2)}</dd>
				<dt class="text-text-muted">{t('cost_limits.hard.max_per_spawn')}</dt>
				<dd class="font-mono">${(usage.hard_limits.max_per_spawn_cents / 100).toFixed(2)}</dd>
				<dt class="text-text-muted">{t('cost_limits.hard.http_rate')}</dt>
				<dd class="font-mono">{usage.hard_limits.tool_http_per_hour}/h · {usage.hard_limits.tool_http_per_day}/d</dd>
				<dt class="text-text-muted">{t('cost_limits.hard.spawn_parallel')}</dt>
				<dd class="font-mono">{usage.hard_limits.spawn_max_agents_per_call} ({t('cost_limits.hard.depth')} {usage.hard_limits.spawn_max_depth})</dd>
			</dl>
		{:else if usage?.hard_limits}
			<p class="text-sm">{t('cost_limits.hard.managed_notice')} <a href="mailto:support@lynox.ai" class="text-accent-text underline">support@lynox.ai</a></p>
		{:else}
			<p class="text-xs text-text-muted">{t('cost_limits.loading')}</p>
		{/if}
	</section>
</div>
