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
	  - workflows <WorkflowsView /> — the full workflow run-list (per-run cost +
	              status + "💬 Fixen" for failed runs). Moved here from Automation
	              in the IA reorg: Activity & Cost owns *runs*, Automation owns the
	              workflow *definitions* (Library).

	Cost formatters come from `format.ts` (canonical SSoT — never re-implemented
	locally). CostLimits-Page was deleted in P3-PR-X; AutomationHub Activity-Tab
	was retired earlier in P2-PR-D.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { formatCostCents, shortModel } from '../format.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import HistoryView from './HistoryView.svelte';
	import WorkflowsView from './WorkflowsView.svelte';

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
	// Rolling daily cost in the user's LOCAL timezone — the single source for the
	// "Heute" tile AND the 14-day chart, shared with the StatusBar footer so the
	// two never disagree on "today" (rafael 2026-06-04). Deriving these from the
	// month-to-date `daily` tail showed the wrong day + stale dates early in the
	// month; a rolling tz-aware fetch is what "last 14 days ending today" means.
	let dailyRolling = $state<Array<{ day: string; cost_usd: number; run_count: number }>>([]);
	let overviewLoading = $state(true);
	let overviewError = $state('');

	/** YYYY-MM-DD for the user's LOCAL today, matching the server's tz-shifted
	 *  bucket key (see /history/cost/daily tzOffsetMin). */
	function localTodayKey(): string {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}

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
		const tz = new Date().getTimezoneOffset();
		const [mtd, sevenDay, thirtyDay, daily] = await Promise.all([
			fetchSummary('current'),
			fetchSummary('7d'),
			fetchSummary('30d'),
			fetch(`${getApiBase()}/history/cost/daily?days=14&tzOffsetMin=${tz}`)
				.then(r => r.ok ? r.json() as Promise<Array<{ day: string; cost_usd: number; run_count: number }>> : [])
				.catch(() => []),
		]);
		if (!mtd && !sevenDay && !thirtyDay) {
			overviewError = t('common.load_failed');
		}
		summaryMTD = mtd;
		summary7d = sevenDay;
		summary30d = thirtyDay;
		dailyRolling = daily;
		overviewLoading = false;
	}

	$effect(() => {
		if (tab === 'overview') void loadOverview();
	});

	// ── Derived KPI rollups ───────────────────────────────────────────────
	// Today = the LOCAL-today bucket from the rolling daily feed (same source +
	// tz as the footer), NOT the MTD daily tail — which early in the month
	// pointed at a mid-month/zero bucket and disagreed with the footer.
	const todayCents = $derived.by(() => {
		const key = localTodayKey();
		const row = dailyRolling.find(r => r.day === key);
		return row ? Math.round(row.cost_usd * 100) : 0;
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

	// ── 14-day bar chart: last 14 LOCAL days ending today (rolling, tz-aware) ──
	// The daily feed is DESC (newest first); reverse to ascending and shape it
	// like the old MTD entries ({date, cost_cents}) so the chart markup is
	// unchanged. This is what "14 days" should mean — not the tail of the
	// month-to-date array (which showed stale May dates on June 4).
	const chartDays = $derived.by(() =>
		[...dailyRolling]
			.reverse()
			.slice(-14)
			.map(r => ({ date: r.day, cost_cents: Math.round(r.cost_usd * 100) })),
	);
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

	// ── Workflows tab ─────────────────────────────────────────────────────
	// The full workflow run-list now lives in <WorkflowsView /> (moved here from
	// Automation in the IA reorg). It owns its own load/empty/error states + the
	// "💬 Fixen" failed-run flow, so there's no aggregate data to compute here.

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
							class="inline-flex items-center gap-1.5 mt-5 rounded-[var(--radius-sm)] bg-accent text-accent-fg px-4 py-2 text-sm hover:opacity-90 transition-opacity"
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
							class="inline-flex items-center gap-1.5 mt-5 rounded-[var(--radius-sm)] bg-accent text-accent-fg px-4 py-2 text-sm hover:opacity-90 transition-opacity"
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
			<!-- Full workflow run-list (per-run cost + status + "💬 Fixen"). Owns its
				 own load/empty/error states + p-6 padding — no extra wrapper here. -->
			<WorkflowsView />
		{/if}
	</div>
</div>
