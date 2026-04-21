<!--
	Usage Dashboard (Phase 2 of prd/usage-dashboard.md).

	Renders inside Settings → Budget & Usage. Reads GET /api/usage/summary
	and displays:
	  - Tier badge (when managed)
	  - Period selector (current month / last month / rolling 7d / rolling 30d)
	  - Progress bar (hidden if budget_cents is 0 — managed tier before Phase 3,
	    or self-host without a configured monthly limit)
	  - Per-model breakdown list (cost + run count + tokens for LLM rows,
	    cost + unit count for voice rows)
	  - Daily trend sparkline (pure inline SVG, no chart lib)

	No in-app credit-pack purchase surface — that stays in the external Stripe
	Customer Portal (see PRD non-goals). 80 / 95 % threshold toasts are Phase 4.
-->
<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';

	type Period = 'current' | 'prev' | '7d' | '30d';

	interface ByModel {
		model_id: string;
		cost_cents: number;
		run_count: number;
		tokens_in: number;
		tokens_out: number;
		tokens_cache_read: number;
	}
	interface ByKind {
		kind: 'llm' | 'voice_stt' | 'voice_tts';
		cost_cents: number;
		unit_count: number;
		unit_label: 'tokens' | 'characters' | 'seconds';
		run_count: number;
	}
	interface Daily {
		date: string;
		cost_cents: number;
	}
	interface UsageSummary {
		tier: string | null;
		period: { label: string; start_iso: string; end_iso: string; source: string };
		used_cents: number;
		budget_cents: number;
		by_model: ByModel[];
		by_kind: ByKind[];
		daily: Daily[];
	}

	let period = $state<Period>('current');
	let summary = $state<UsageSummary | null>(null);
	let loading = $state(true);
	let error = $state('');

	async function load(p: Period): Promise<void> {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/usage/summary?period=${p}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			summary = (await res.json()) as UsageSummary;
		} catch (e) {
			error = e instanceof Error ? e.message : t('usage.load_failed');
			summary = null;
		}
		loading = false;
	}

	$effect(() => { load(period); });

	// ── Derived presentation ────────────────────────────────────────────────
	const pct = $derived(
		summary && summary.budget_cents > 0
			? Math.min(100, Math.round((summary.used_cents / summary.budget_cents) * 100))
			: 0,
	);
	// Amber at 80 %, red at 95 % — signals budget pressure without toasts
	// (threshold toasts are Phase 4).
	const barColor = $derived(
		pct >= 95 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent',
	);
	const remainingCents = $derived(
		summary ? Math.max(0, summary.budget_cents - summary.used_cents) : 0,
	);

	// Map a by_model row to a concise secondary label. LLM rows have real
	// tokens; voice rows carry their char / second count in by_kind. We
	// derive the voice unit here from by_kind rather than threading an
	// extra `kind` field through the API response.
	function secondary(row: ByModel): string {
		if (row.tokens_in > 0 || row.tokens_out > 0) {
			return `${formatInt(row.tokens_in)} in · ${formatInt(row.tokens_out)} out`
				+ (row.tokens_cache_read > 0 ? ` · ${formatInt(row.tokens_cache_read)} cache` : '');
		}
		// Voice model — look up matching by_kind row for unit count.
		const voiceKind = summary?.by_kind.find(k =>
			k.kind === (row.model_id.includes('tts') ? 'voice_tts' : 'voice_stt'),
		);
		if (!voiceKind) return `${row.run_count} ${t('usage.runs')}`;
		return `${formatInt(voiceKind.unit_count)} ${t(`usage.unit_${voiceKind.unit_label}`)}`;
	}

	function formatCents(c: number): string {
		// Sub-cent costs round to 0 on the API side (integer cents over the
		// wire). For small values we show "< $0.01" instead of "$0.00" so
		// voice rows don't look like they cost nothing.
		if (c === 0) return '$0.00';
		if (c < 1) return '< $0.01';
		const d = Math.floor(c / 100);
		const r = (c % 100).toString().padStart(2, '0');
		return `$${d}.${r}`;
	}

	function formatInt(n: number): string {
		return n.toLocaleString('en-US');
	}

	// ── Sparkline (pure SVG, no chart lib) ──────────────────────────────────
	const SPARK_W = 320;
	const SPARK_H = 48;
	const sparkPoints = $derived.by(() => {
		if (!summary || summary.daily.length === 0) return '';
		const max = Math.max(1, ...summary.daily.map(d => d.cost_cents));
		const stepX = SPARK_W / Math.max(1, summary.daily.length - 1);
		return summary.daily
			.map((d, i) => {
				const x = i * stepX;
				const y = SPARK_H - (d.cost_cents / max) * SPARK_H;
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');
	});
	const hasSparkData = $derived(
		summary !== null && summary.daily.some(d => d.cost_cents > 0),
	);

	const periodButtons: Array<{ id: Period; key: string }> = [
		{ id: 'current', key: 'usage.period_current' },
		{ id: 'prev',    key: 'usage.period_prev' },
		{ id: '7d',      key: 'usage.period_7d' },
		{ id: '30d',     key: 'usage.period_30d' },
	];

	// Tier label: 'managed' / 'managed_pro' / 'starter' / 'eu' → human name.
	// `eu` is the legacy Roland grandfathered tier; keep the label minimal.
	const tierLabel = $derived.by(() => {
		if (!summary?.tier) return null;
		const m: Record<string, string> = {
			starter: 'Hosted',
			managed: 'Managed',
			managed_pro: 'Managed Pro',
			eu: 'EU (legacy)',
		};
		return m[summary.tier] ?? summary.tier;
	});

	const cardClass = 'rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4';
</script>

<section class="space-y-4" aria-label={t('usage.title')}>
	<!-- Tier badge + period selector -->
	<div class="flex items-center justify-between gap-3 flex-wrap">
		<div class="flex items-center gap-2">
			<h2 class="text-sm font-medium">{t('usage.title')}</h2>
			{#if tierLabel}
				<span class="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-full border border-border text-text-muted">
					{tierLabel}
				</span>
			{/if}
		</div>
		<div role="tablist" class="flex gap-1 text-xs">
			{#each periodButtons as btn}
				<button
					type="button"
					role="tab"
					aria-selected={period === btn.id}
					onclick={() => (period = btn.id)}
					class="px-2.5 py-1 rounded-[var(--radius-sm)] border transition-colors {period === btn.id ? 'border-accent bg-accent/10 text-text' : 'border-border text-text-muted hover:text-text'}"
				>
					{t(btn.key)}
				</button>
			{/each}
		</div>
	</div>

	{#if loading}
		<div class={cardClass}>
			<div class="h-4 w-40 bg-border rounded animate-pulse"></div>
			<div class="h-3 w-full bg-border/60 rounded mt-4 animate-pulse"></div>
			<div class="h-3 w-5/6 bg-border/60 rounded mt-2 animate-pulse"></div>
		</div>
	{:else if error}
		<div class={cardClass}>
			<p class="text-sm text-danger">{error}</p>
		</div>
	{:else if summary}
		<!-- Summary card: period label + progress bar (if budget known) + remaining -->
		<div class={cardClass}>
			<div class="flex items-baseline justify-between gap-3 flex-wrap">
				<p class="text-xs text-text-muted">{summary.period.label}</p>
				{#if summary.by_model.length === 0}
					<p class="text-sm text-text-muted">{t('usage.no_data')}</p>
				{/if}
			</div>

			<p class="text-2xl font-light tracking-tight mt-1">
				{formatCents(summary.used_cents)}
				{#if summary.budget_cents > 0}
					<span class="text-sm text-text-muted">/ {formatCents(summary.budget_cents)}</span>
				{/if}
			</p>

			{#if summary.budget_cents > 0}
				<div class="h-2 w-full rounded-full bg-border mt-3 overflow-hidden" aria-label={t('usage.budget_bar_label')}>
					<div class="h-full {barColor} transition-all" style="width:{pct}%"></div>
				</div>
				<p class="text-xs text-text-muted mt-2">
					{t('usage.remaining_prefix')}
					<strong class="text-text">{formatCents(remainingCents)}</strong>
					· {pct}{t('usage.percent_used_suffix')}
				</p>
			{:else if summary.tier === 'managed' || summary.tier === 'managed_pro' || summary.tier === 'eu'}
				<p class="text-xs text-text-muted mt-2 italic">{t('usage.managed_budget_pending')}</p>
			{:else if summary.used_cents > 0}
				<p class="text-xs text-text-muted mt-2 italic">{t('usage.selfhost_no_limit_hint')}</p>
			{/if}
		</div>

		<!-- Sparkline — daily trend -->
		{#if hasSparkData}
			<div class={cardClass}>
				<p class="text-xs text-text-muted mb-2">{t('usage.daily_trend')}</p>
				<svg viewBox="0 0 {SPARK_W} {SPARK_H}" class="w-full h-12" role="img" aria-label={t('usage.daily_trend')}>
					<polyline
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
						class="text-accent"
						points={sparkPoints}
					/>
				</svg>
			</div>
		{/if}

		<!-- Breakdown by model -->
		{#if summary.by_model.length > 0}
			<div class={cardClass}>
				<p class="text-xs text-text-muted mb-3">{t('usage.breakdown_title')}</p>
				<ul class="space-y-2">
					{#each summary.by_model as row}
						<li class="flex items-baseline justify-between gap-4 text-sm">
							<div class="min-w-0 flex-1">
								<p class="font-mono text-xs truncate">{row.model_id}</p>
								<p class="text-xs text-text-muted mt-0.5">
									{row.run_count} {t('usage.runs')} · {secondary(row)}
								</p>
							</div>
							<p class="tabular-nums shrink-0">{formatCents(row.cost_cents)}</p>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/if}
</section>
