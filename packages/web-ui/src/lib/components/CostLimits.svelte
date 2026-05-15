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
	let managed = $state<boolean | null>(null);

	async function load(): Promise<void> {
		const [usageRes, configRes] = await Promise.all([
			fetch(`${getApiBase()}/usage/current`),
			fetch(`${getApiBase()}/config`),
		]);
		if (usageRes.ok) usage = (await usageRes.json()) as UsageCurrent;
		if (configRes.ok) {
			const body = (await configRes.json()) as UserConfig & { managed?: string };
			config = { ...body };
			managed = body.managed === 'managed' || body.managed === 'managed_pro' || body.managed === 'eu';
		}
	}

	async function saveConfig(): Promise<void> {
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

	const isNumericHardLimits = $derived((h: HardLimits | undefined): h is HardLimitsNumeric => !!h && 'per_spawn_cents' in h);
	const projectionLabel = $derived.by(() => {
		if (!usage?.projection?.exhaust_eta_iso) return '';
		const eta = new Date(usage.projection.exhaust_eta_iso);
		const days = Math.max(0, Math.round((eta.getTime() - Date.now()) / 86_400_000));
		return t('cost_limits.projection').replace('{days}', days.toString());
	});

	// Context window: 200k / 500k / 1M choices with relative-cost framing.
	const CONTEXT_OPTIONS = [
		{ value: 200_000, label: t('cost_limits.context.standard'), hint: t('cost_limits.context.standard_hint') },
		{ value: 500_000, label: t('cost_limits.context.extended'), hint: t('cost_limits.context.extended_hint') },
		{ value: 1_000_000, label: t('cost_limits.context.maximum'), hint: t('cost_limits.context.maximum_hint') },
	];
</script>

<div class="space-y-6 max-w-3xl mx-auto p-4">
	<header>
		<h1 class="text-2xl font-semibold mb-1">{t('cost_limits.title')}</h1>
		<p class="text-sm text-text-muted">{t('cost_limits.subtitle')}</p>
		{#if projectionLabel}
			<p class="text-xs text-amber-600 mt-2" role="status" aria-live="polite">{projectionLabel}</p>
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
					<input type="number" step="1" min="0" placeholder="—" class="w-full font-mono px-2 py-1 border border-border rounded bg-bg"
						bind:value={config.max_monthly_cost_usd} />
				</label>
				<label class="block">
					<span class="block text-sm mb-1">{t('config.daily_limit')}</span>
					<input type="number" step="0.5" min="0" placeholder="—" class="w-full font-mono px-2 py-1 border border-border rounded bg-bg"
						bind:value={config.max_daily_cost_usd} />
				</label>
				<label class="block">
					<span class="block text-sm mb-1">{t('config.session_limit')}</span>
					<input type="number" step="0.5" min="0" placeholder="5.00" class="w-full font-mono px-2 py-1 border border-border rounded bg-bg"
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
			{#each CONTEXT_OPTIONS as opt (opt.value)}
				<label class="flex items-start gap-3 cursor-pointer">
					<input type="radio" name="context-window" value={opt.value} bind:group={config.max_context_window_tokens}
						class="mt-1" />
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
		<button type="button" onclick={saveConfig} disabled={saving}
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
