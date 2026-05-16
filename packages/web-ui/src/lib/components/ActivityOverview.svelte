<!--
	ActivityOverview — canonical Activity Root (PRD-IA-V2 P2-PR-A).

	Fuses the former ActivityHub Dashboard tab + UsageDashboard into a single
	consolidated surface. The Footer-Glance (StatusBar) and this Dashboard now
	read from the same SSoT (`/api/usage/summary`); per-run detail keeps
	`/api/history/*` for the History tab.

	Three tabs, query-param routed (`?tab=overview|history|workflows`):
	  - overview  KPI Cards (today / 7d / 30d / MTD) + 14d bar chart + by-model +
	              by-kind (LLM / voice_tts / voice_stt) + projection-ETA banner.
	  - history   <HistoryView /> — Run list, filters, CSV, grouped by thread.
	  - workflows Aggregate-only per pipeline (cost / runs / avg duration).
	              Per-step drill stays in Hub-Builder via the deep-link.

	Cost formatters come from `format.ts` (canonical SSoT — never re-implemented
	locally). The CostLimits-Page + AutomationHub Activity-Tab still exist
	during the P2 phase; deletion lands in P2-PR-B/D.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { formatCost, formatCostCents, formatDuration, shortModel } from '../format.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import HistoryView from './HistoryView.svelte';

	type Tab = 'overview' | 'history' | 'workflows';
	type Period = 'current' | 'prev' | '7d' | '30d';

	const tabs: Array<{ id: Tab; labelKey: string }> = [
		{ id: 'overview',  labelKey: 'activity.tab.overview' },
		{ id: 'history',   labelKey: 'activity.tab.history' },
		{ id: 'workflows', labelKey: 'activity.tab.workflows' },
	];

	// ── Tab routing via ?tab= ─────────────────────────────────────────────
	let tab = $state<Tab>('overview');

	$effect(() => {
		const p = $page.url.searchParams.get('tab');
		tab = p === 'history' || p === 'workflows' ? p : 'overview';
	});

	function selectTab(next: Tab): void {
		// Preserve `?tab=` in the URL so back/forward + deeplinks survive a reload.
		// Overview is the default — strip the param to keep the URL canonical.
		const url = new URL($page.url);
		if (next === 'overview') url.searchParams.delete('tab');
		else url.searchParams.set('tab', next);
		void goto(`${url.pathname}${url.search}`, { keepFocus: true, replaceState: false, noScroll: true });
	}

	// ── Overview data ─────────────────────────────────────────────────────
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
	interface Projection {
		exhaust_eta_iso: string | null;
		projection_basis_days: number;
	}
	interface UsageSummary {
		tier: string | null;
		period: { label: string; start_iso: string; end_iso: string; source: string };
		used_cents: number;
		budget_cents: number;
		limit_cents: number | null;
		by_model: ByModel[];
		by_kind: ByKind[];
		daily: Daily[];
		projection: Projection | null;
	}

	let summaryMTD = $state<UsageSummary | null>(null);
	let summary7d = $state<UsageSummary | null>(null);
	let summary30d = $state<UsageSummary | null>(null);
	let overviewLoading = $state(true);
	let overviewError = $state('');

	async function fetchSummary(period: Period): Promise<UsageSummary | null> {
		try {
			const res = await fetch(`${getApiBase()}/usage/summary?period=${period}`);
			if (!res.ok) return null;
			return (await res.json()) as UsageSummary;
		} catch {
			return null;
		}
	}

	async function loadOverview(): Promise<void> {
		overviewLoading = true;
		overviewError = '';
		const [mtd, sevenDay, thirtyDay] = await Promise.all([
			fetchSummary('current'),
			fetchSummary('7d'),
			fetchSummary('30d'),
		]);
		if (!mtd && !sevenDay && !thirtyDay) {
			overviewError = t('common.load_failed');
		}
		summaryMTD = mtd;
		summary7d = sevenDay;
		summary30d = thirtyDay;
		overviewLoading = false;
	}

	$effect(() => {
		if (tab === 'overview') void loadOverview();
	});

	// ── Derived KPI rollups ───────────────────────────────────────────────
	// Today = last entry of MTD's daily array (calendar-month rolling forward).
	// `/usage/summary?period=today` doesn't exist; deriving from `daily` keeps
	// the request count to three and Footer + Dashboard reading the same SSoT.
	const todayCents = $derived.by(() => {
		if (!summaryMTD || summaryMTD.daily.length === 0) return 0;
		const last = summaryMTD.daily[summaryMTD.daily.length - 1];
		return last?.cost_cents ?? 0;
	});
	const totalRunsMTD = $derived(
		(summaryMTD?.by_model ?? []).reduce((sum, m) => sum + m.run_count, 0),
	);
	const totalRuns7d = $derived(
		(summary7d?.by_model ?? []).reduce((sum, m) => sum + m.run_count, 0),
	);
	const totalRuns30d = $derived(
		(summary30d?.by_model ?? []).reduce((sum, m) => sum + m.run_count, 0),
	);

	// Empty-state predicate — used identically across tabs.
	const isOverviewEmpty = $derived(
		!overviewLoading
		&& !overviewError
		&& totalRunsMTD === 0
		&& totalRuns7d === 0
		&& totalRuns30d === 0,
	);

	// ── 14-day bar chart (from MTD daily, take last 14 entries) ───────────
	const chartDays = $derived.by(() => {
		const all = summaryMTD?.daily ?? [];
		return all.slice(-14);
	});
	const maxChartCents = $derived(
		Math.max(1, ...chartDays.map(d => d.cost_cents)),
	);

	function shortDay(iso: string): string {
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
	}

	// ── Projection-ETA banner ─────────────────────────────────────────────
	const projection = $derived(summaryMTD?.projection ?? null);

	function projectionDaysRemaining(etaIso: string): number {
		const ms = new Date(etaIso).getTime() - Date.now();
		return Math.max(0, Math.round(ms / 86_400_000));
	}

	// ── by_kind helpers ───────────────────────────────────────────────────
	const kindLabels: Record<ByKind['kind'], string> = {
		llm:       'activity.kind.llm',
		voice_stt: 'activity.kind.voice_stt',
		voice_tts: 'activity.kind.voice_tts',
	};

	// ── Workflows-tab data (aggregate-only) ───────────────────────────────
	interface PipelineRun {
		id: string;
		manifest_name: string;
		status: string;
		total_duration_ms: number;
		total_cost_usd: number;
		step_count: number;
		started_at: string;
	}
	interface PipelineAggregate {
		name: string;
		runCount: number;
		totalCostUsd: number;
		avgDurationMs: number;
		lastRunIso: string;
	}

	let pipelineRuns = $state<PipelineRun[]>([]);
	let workflowsLoading = $state(true);
	let workflowsError = $state('');

	async function loadWorkflows(): Promise<void> {
		workflowsLoading = true;
		workflowsError = '';
		try {
			const res = await fetch(`${getApiBase()}/pipelines?limit=200`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { runs: PipelineRun[] };
			pipelineRuns = data.runs;
		} catch {
			workflowsError = t('common.load_failed');
			pipelineRuns = [];
		}
		workflowsLoading = false;
	}

	$effect(() => {
		if (tab === 'workflows') void loadWorkflows();
	});

	const pipelineAggregates = $derived.by(() => {
		const map = new Map<string, { runs: PipelineRun[] }>();
		for (const run of pipelineRuns) {
			const key = run.manifest_name || '(unnamed)';
			const entry = map.get(key);
			if (entry) entry.runs.push(run);
			else map.set(key, { runs: [run] });
		}
		const out: PipelineAggregate[] = [];
		for (const [name, { runs }] of map) {
			const runCount = runs.length;
			const totalCostUsd = runs.reduce((s, r) => s + (r.total_cost_usd || 0), 0);
			const totalDuration = runs.reduce((s, r) => s + (r.total_duration_ms || 0), 0);
			const avgDurationMs = runCount > 0 ? totalDuration / runCount : 0;
			const lastRunIso = runs
				.map(r => r.started_at)
				.sort()
				.reverse()[0] ?? '';
			out.push({ name, runCount, totalCostUsd, avgDurationMs, lastRunIso });
		}
		// Sort highest-cost first — that's the "where is my money going" question.
		out.sort((a, b) => b.totalCostUsd - a.totalCostUsd);
		return out;
	});

	const isWorkflowsEmpty = $derived(
		!workflowsLoading && !workflowsError && pipelineAggregates.length === 0,
	);

	function pipelineDeepLink(pipelineId: string): string {
		// Per PRD: per-step drill stays in Hub-Builder.
		return `/app/hub?section=workflows&pipeline=${encodeURIComponent(pipelineId)}`;
	}

	// Find the most recent run for a given pipeline name, used as the deep-link
	// target (Hub-Builder opens by run-id).
	function pipelineRunIdForName(name: string): string | null {
		const matches = pipelineRuns
			.filter(r => (r.manifest_name || '(unnamed)') === name)
			.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
		return matches[0]?.id ?? null;
	}

	// ── History-tab empty state (synthetic — HistoryView itself shows its own
	// loading spinner; the empty-state we render here matches the Overview /
	// Workflows pattern so the user always sees the same affordance).
	// We hit `/history/stats` cheaply to decide.
	let historyHasData = $state<boolean | null>(null);
	let historyProbed = $state(false);

	async function probeHistory(): Promise<void> {
		if (historyProbed) return;
		historyProbed = true;
		try {
			const res = await fetch(`${getApiBase()}/history/stats`);
			if (!res.ok) {
				historyHasData = null;
				return;
			}
			const stats = (await res.json()) as { total_runs?: number };
			historyHasData = (stats.total_runs ?? 0) > 0;
		} catch {
			historyHasData = null;
		}
	}

	$effect(() => {
		if (tab === 'history') void probeHistory();
	});

	const isHistoryEmpty = $derived(tab === 'history' && historyHasData === false);

	const cardClass = 'rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4';
</script>

<div class="flex flex-col h-full">
	<!-- Tab strip -->
	<div class="flex items-center gap-1 px-4 sm:px-5 py-3 border-b border-border shrink-0 overflow-x-auto scrollbar-none">
		{#each tabs as item (item.id)}
			<button
				type="button"
				class="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors {tab === item.id ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
				aria-pressed={tab === item.id}
				onclick={() => selectTab(item.id)}
			>{t(item.labelKey)}</button>
		{/each}
	</div>

	<div class="flex-1 overflow-y-auto">
		{#if tab === 'overview'}
			<div class="p-6 max-w-3xl mx-auto space-y-6">
				{#if overviewLoading}
					<p class="text-text-muted text-sm">{t('common.loading')}</p>
				{:else if overviewError}
					<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">
						{overviewError}
					</div>
				{:else if isOverviewEmpty}
					<!-- Empty-state — same affordance shape on all 3 tabs. -->
					<div class={cardClass + ' text-center py-10'}>
						<h2 class="text-base font-medium text-text">{t('activity.empty.heading')}</h2>
						<p class="text-sm text-text-muted mt-2 max-w-md mx-auto">{t('activity.empty.description')}</p>
						<a
							href="/app"
							class="inline-flex items-center gap-1.5 mt-5 rounded-[var(--radius-sm)] bg-accent text-text px-4 py-2 text-sm hover:opacity-90 transition-opacity"
						>
							{t('activity.empty.cta')}
						</a>
					</div>
				{:else}
					<!-- KPI Cards (today / 7d / 30d / MTD) -->
					<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
						<div class={cardClass}>
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('activity.kpi.today')}</p>
							<p class="text-2xl font-light text-text mt-1">{formatCostCents(todayCents)}</p>
						</div>
						<div class={cardClass}>
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('activity.kpi.7d')}</p>
							<p class="text-2xl font-light text-text mt-1">{formatCostCents(summary7d?.used_cents ?? 0)}</p>
							<p class="text-[11px] text-text-subtle mt-0.5">{totalRuns7d} {t('usage.runs')}</p>
						</div>
						<div class={cardClass}>
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('activity.kpi.30d')}</p>
							<p class="text-2xl font-light text-text mt-1">{formatCostCents(summary30d?.used_cents ?? 0)}</p>
							<p class="text-[11px] text-text-subtle mt-0.5">{totalRuns30d} {t('usage.runs')}</p>
						</div>
						<div class={cardClass}>
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('activity.kpi.mtd')}</p>
							<p class="text-2xl font-light text-text mt-1">{formatCostCents(summaryMTD?.used_cents ?? 0)}</p>
							{#if summaryMTD && summaryMTD.budget_cents > 0}
								<p class="text-[11px] text-text-subtle mt-0.5">
									{t('activity.kpi.of_budget').replace('{budget}', formatCostCents(summaryMTD.budget_cents))}
								</p>
							{:else}
								<p class="text-[11px] text-text-subtle mt-0.5">{totalRunsMTD} {t('usage.runs')}</p>
							{/if}
						</div>
					</div>

					<!-- Projection ETA banner (only when budget set + on pace to exhaust) -->
					{#if projection?.exhaust_eta_iso}
						{@const days = projectionDaysRemaining(projection.exhaust_eta_iso)}
						<div class="rounded-[var(--radius-md)] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
							{t('activity.projection.warning').replace('{days}', String(days))}
						</div>
					{/if}

					<!-- 14-day bar chart -->
					{#if chartDays.length > 0}
						<div class={cardClass + ' overflow-hidden'}>
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-3">
								{t('activity.chart.title')}
							</p>
							<div class="flex gap-0.5 sm:gap-1 h-24 overflow-x-auto scrollbar-none">
								{#each chartDays as day (day.date)}
									<div class="flex-1 flex flex-col items-center gap-1 group relative">
										<div class="flex-1 w-full flex items-end">
											<div
												class="w-full rounded-t-sm bg-accent/60 hover:bg-accent transition-colors"
												style="height: {Math.max((day.cost_cents / maxChartCents) * 100, 2)}%"
											></div>
										</div>
										<span class="text-[8px] text-text-subtle shrink-0">{shortDay(day.date)}</span>
										<div class="absolute bottom-full mb-2 hidden group-hover:block bg-bg border border-border rounded-[var(--radius-sm)] px-2 py-1 text-[10px] text-text whitespace-nowrap z-10">
											{formatCostCents(day.cost_cents)}
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- By-kind (LLM / voice_tts / voice_stt) — sourced from MTD summary -->
					{#if summaryMTD && summaryMTD.by_kind.length > 0}
						<div class={cardClass}>
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-3">
								{t('activity.by_kind.title')}
							</p>
							<div class="space-y-2">
								{#each summaryMTD.by_kind as row (row.kind)}
									<div class="flex items-center justify-between text-sm">
										<div class="min-w-0">
											<p class="text-text">{t(kindLabels[row.kind])}</p>
											<p class="text-[11px] text-text-subtle mt-0.5">
												{row.run_count} {t('usage.runs')} · {row.unit_count.toLocaleString('en-US')} {t(`usage.unit_${row.unit_label}`)}
											</p>
										</div>
										<p class="tabular-nums text-text shrink-0">{formatCostCents(row.cost_cents)}</p>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- By-model breakdown (MTD) -->
					{#if summaryMTD && summaryMTD.by_model.length > 0}
						<div class={cardClass}>
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-3">
								{t('hub.activity.by_model')}
							</p>
							<ul class="space-y-2">
								{#each summaryMTD.by_model as row (row.model_id)}
									<li class="flex items-baseline justify-between gap-4 text-sm">
										<div class="min-w-0 flex-1">
											<p class="font-mono text-xs truncate">{shortModel(row.model_id)}</p>
											<p class="text-[11px] text-text-subtle mt-0.5">
												{row.run_count} {t('usage.runs')}
												{#if row.tokens_in > 0 || row.tokens_out > 0}
													· {row.tokens_in.toLocaleString('en-US')} in · {row.tokens_out.toLocaleString('en-US')} out
													{#if row.tokens_cache_read > 0}
														· {row.tokens_cache_read.toLocaleString('en-US')} cache
													{/if}
												{/if}
											</p>
										</div>
										<p class="tabular-nums text-text shrink-0">{formatCostCents(row.cost_cents)}</p>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
				{/if}
			</div>
		{:else if tab === 'history'}
			{#if isHistoryEmpty}
				<div class="p-6 max-w-3xl mx-auto">
					<div class={cardClass + ' text-center py-10'}>
						<h2 class="text-base font-medium text-text">{t('activity.empty.heading')}</h2>
						<p class="text-sm text-text-muted mt-2 max-w-md mx-auto">{t('activity.empty.history.description')}</p>
						<a
							href="/app"
							class="inline-flex items-center gap-1.5 mt-5 rounded-[var(--radius-sm)] bg-accent text-text px-4 py-2 text-sm hover:opacity-90 transition-opacity"
						>
							{t('activity.empty.cta')}
						</a>
					</div>
				</div>
			{:else}
				<!-- HistoryView is the canonical Run-list surface. Its built-in Cost-Chart
					 + Model-Breakdown buttons are redundant with the Overview tab; per PRD
					 the cleanup of those buttons is Phase 3 polish (not P2-PR-A scope). -->
				<HistoryView />
			{/if}
		{:else if tab === 'workflows'}
			<div class="p-6 max-w-3xl mx-auto space-y-4">
				{#if workflowsLoading}
					<p class="text-text-muted text-sm">{t('common.loading')}</p>
				{:else if workflowsError}
					<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger">
						{workflowsError}
					</div>
				{:else if isWorkflowsEmpty}
					<div class={cardClass + ' text-center py-10'}>
						<h2 class="text-base font-medium text-text">{t('activity.empty.heading')}</h2>
						<p class="text-sm text-text-muted mt-2 max-w-md mx-auto">{t('activity.empty.workflows.description')}</p>
						<a
							href="/app"
							class="inline-flex items-center gap-1.5 mt-5 rounded-[var(--radius-sm)] bg-accent text-text px-4 py-2 text-sm hover:opacity-90 transition-opacity"
						>
							{t('activity.empty.cta')}
						</a>
					</div>
				{:else}
					<p class="text-xs text-text-subtle">{t('activity.workflows.subtitle')}</p>
					<div class="space-y-2">
						{#each pipelineAggregates as agg (agg.name)}
							{@const runId = pipelineRunIdForName(agg.name)}
							<div class={cardClass + ' flex items-center gap-3'}>
								<div class="flex-1 min-w-0">
									<p class="text-sm font-medium text-text truncate">{agg.name}</p>
									<div class="flex flex-wrap gap-3 mt-1 text-[11px] text-text-subtle">
										<span>{agg.runCount} {t('usage.runs')}</span>
										<span>{t('activity.workflows.avg_label')}: {formatDuration(agg.avgDurationMs)}</span>
									</div>
								</div>
								<div class="text-right shrink-0">
									<p class="text-sm text-text tabular-nums">{formatCost(agg.totalCostUsd)}</p>
									{#if runId}
										<a
											href={pipelineDeepLink(runId)}
											class="text-[11px] text-accent-text hover:opacity-80"
										>{t('activity.workflows.per_step_link')}</a>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
