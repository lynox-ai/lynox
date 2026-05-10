<script lang="ts">
	import { page } from '$app/stores';
	import { getApiBase } from '../config.svelte.js';
	import { formatCost, formatDuration } from '../format.js';
	import { t } from '../i18n.svelte.js';
	import WorkflowsView from './WorkflowsView.svelte';

	interface CostStat {
		manifest_name: string;
		run_count: number;
		avg_cost_usd: number;
		total_cost_usd: number;
		avg_duration_ms: number;
		success_count?: number;
		fail_count?: number;
	}

	interface StepStat {
		step_id: string;
		manifest_name: string;
		avg_duration_ms: number;
		total_runs: number;
		fail_count: number;
		avg_cost_usd: number;
	}

	const tabs = [
		{ id: 'list' as const, labelKey: 'hub.workflow.list' },
		{ id: 'analytics' as const, labelKey: 'hub.workflow.analytics' },
	];

	const ranges = [
		{ days: 7, label: '7d' },
		{ days: 30, label: '30d' },
		{ days: 90, label: '90d' },
	];

	let tab = $state<'list' | 'analytics'>('list');

	$effect(() => {
		const p = $page.url.searchParams.get('tab');
		if (p === 'analytics') tab = p;
		else tab = 'list';
	});

	let days = $state(30);
	let costStats = $state<CostStat[]>([]);
	let stepStats = $state<StepStat[]>([]);
	let statsLoading = $state(false);

	async function loadStats() {
		statsLoading = true;
		try {
			const [costRes, stepRes] = await Promise.all([
				fetch(`${getApiBase()}/pipelines/stats/cost?days=${days}`),
				fetch(`${getApiBase()}/pipelines/stats/steps?days=${days}`),
			]);
			if (costRes.ok) {
				const data = (await costRes.json()) as { stats: CostStat[] };
				costStats = data.stats;
			}
			if (stepRes.ok) {
				const data = (await stepRes.json()) as { stats: StepStat[] };
				stepStats = data.stats;
			}
		} catch { /* silent */ }
		statsLoading = false;
	}

	// Aggregated summary
	const totalRuns = $derived(costStats.reduce((sum, s) => sum + s.run_count, 0));
	const totalCost = $derived(costStats.reduce((sum, s) => sum + s.total_cost_usd, 0));
	const avgDuration = $derived(
		costStats.length > 0
			? costStats.reduce((sum, s) => sum + s.avg_duration_ms * s.run_count, 0) / Math.max(totalRuns, 1)
			: 0,
	);
	const totalFails = $derived(stepStats.reduce((sum, s) => sum + s.fail_count, 0));
	const totalStepRuns = $derived(stepStats.reduce((sum, s) => sum + s.total_runs, 0));
	const overallSuccessRate = $derived(
		totalStepRuns > 0 ? Math.round(((totalStepRuns - totalFails) / totalStepRuns) * 100) : 100,
	);

	// Max cost for bar scaling
	const maxCost = $derived(Math.max(...costStats.map(s => s.total_cost_usd), 0.0001));

	// Sort steps by fail rate descending
	const sortedSteps = $derived(
		[...stepStats].sort((a, b) => {
			const rateA = a.total_runs > 0 ? a.fail_count / a.total_runs : 0;
			const rateB = b.total_runs > 0 ? b.fail_count / b.total_runs : 0;
			return rateB - rateA;
		}),
	);

	$effect(() => {
		if (tab === 'analytics') loadStats();
	});

	// Reload when days changes while on analytics tab
	$effect(() => {
		// Read `days` to subscribe
		const _d = days;
		if (tab === 'analytics') loadStats();
	});
</script>

<div class="flex flex-col h-full">
	<!-- Tab buttons -->
	<div class="flex items-center gap-1 px-4 sm:px-5 py-3 border-b border-border overflow-x-auto scrollbar-none">
		{#each tabs as t_item}
			<button
				class="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors
					{tab === t_item.id ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
				onclick={() => tab = t_item.id}
			>
				{t(t_item.labelKey)}
			</button>
		{/each}
	</div>

	<!-- Content -->
	<div class="flex-1 overflow-y-auto">
		{#if tab === 'list'}
			<WorkflowsView />
		{:else}
			<div class="p-6 max-w-4xl mx-auto space-y-6">
				<!-- Header row: title + range selector -->
				<div class="flex items-center justify-between">
					<h1 class="text-xl font-light tracking-tight">{t('workflow.analytics_title')}</h1>
					<div class="flex items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-bg-subtle p-0.5">
						{#each ranges as r}
							<button
								class="px-2.5 py-1 rounded-[var(--radius-sm)] text-xs font-mono transition-colors
									{days === r.days ? 'bg-accent/10 text-accent-text' : 'text-text-subtle hover:text-text'}"
								onclick={() => { days = r.days; }}
							>
								{r.label}
							</button>
						{/each}
					</div>
				</div>

				{#if statsLoading}
					<p class="text-text-subtle text-sm">{t('common.loading')}</p>
				{:else if costStats.length === 0 && stepStats.length === 0}
					<div class="text-center py-12 text-text-subtle">
						<p class="text-sm">{t('workflow.no_analytics')}</p>
					</div>
				{:else}
					<!-- Summary cards -->
					<div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('workflow.total_runs')}</p>
							<p class="text-lg font-light tabular-nums mt-0.5">{totalRuns}</p>
						</div>
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('workflow.total_cost')}</p>
							<p class="text-lg font-light font-mono tabular-nums mt-0.5">{formatCost(totalCost)}</p>
						</div>
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('workflow.success_rate')}</p>
							<p class="text-lg font-light tabular-nums mt-0.5 {overallSuccessRate >= 95 ? 'text-success' : overallSuccessRate >= 80 ? 'text-warning' : 'text-danger'}">{overallSuccessRate}%</p>
						</div>
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('workflow.avg_duration')}</p>
							<p class="text-lg font-light font-mono tabular-nums mt-0.5">{formatDuration(avgDuration)}</p>
						</div>
					</div>

					<!-- Cost by workflow (with bar chart) -->
					{#if costStats.length > 0}
						<div>
							<h2 class="text-xs font-medium uppercase tracking-widest text-text-subtle mb-3">{t('workflow.cost_by_workflow')}</h2>
							<div class="space-y-2">
								{#each costStats as stat}
									{@const pct = Math.round((stat.total_cost_usd / maxCost) * 100)}
									{@const successCount = stat.success_count ?? (stat.run_count - (stat.fail_count ?? 0))}
									{@const failCount = stat.fail_count ?? 0}
									{@const successRate = stat.run_count > 0 ? Math.round((successCount / stat.run_count) * 100) : 100}
									<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
										<div class="flex items-center justify-between mb-2">
											<div class="flex items-center gap-2">
												<p class="text-sm font-medium">{stat.manifest_name}</p>
												<span class="text-[10px] rounded-full px-2 py-0.5 font-mono
													{successRate >= 95 ? 'bg-success/10 text-success' : successRate >= 80 ? 'bg-warning/10 text-warning' : 'bg-danger/10 text-danger'}">
													{successRate}%
												</span>
											</div>
											<span class="text-xs font-mono text-text-subtle">{stat.run_count} {stat.run_count === 1 ? t('workflow.run') : t('workflow.runs')}</span>
										</div>
										<!-- Cost bar -->
										<div class="w-full h-1.5 rounded-full bg-border overflow-hidden mb-2">
											<div class="h-full rounded-full bg-accent/60 transition-all duration-500" style="width: {pct}%"></div>
										</div>
										<div class="flex gap-4 text-xs text-text-subtle">
											<span>{t('workflow.total_cost')}: <span class="font-mono text-text-muted">{formatCost(stat.total_cost_usd)}</span></span>
											<span>{t('workflow.avg_cost')}: <span class="font-mono text-text-muted">{formatCost(stat.avg_cost_usd)}</span></span>
											<span>{t('workflow.avg_duration')}: <span class="font-mono text-text-muted">{formatDuration(stat.avg_duration_ms)}</span></span>
											{#if failCount > 0}
												<span class="text-danger">{failCount} {t('workflow.failures')}</span>
											{/if}
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Step performance -->
					{#if stepStats.length > 0}
						<div>
							<h2 class="text-xs font-medium uppercase tracking-widest text-text-subtle mb-3">{t('workflow.step_performance')}</h2>
							<div class="rounded-[var(--radius-md)] border border-border overflow-hidden">
								<table class="w-full text-xs">
									<thead>
										<tr class="bg-bg-subtle text-text-subtle text-left">
											<th class="px-3 py-2 font-medium">{t('workflow.step')}</th>
											<th class="px-3 py-2 font-medium">{t('workflow.workflow_name')}</th>
											<th class="px-3 py-2 font-medium text-right">{t('workflow.runs')}</th>
											<th class="px-3 py-2 font-medium text-right">{t('workflow.fail_rate')}</th>
											<th class="px-3 py-2 font-medium text-right">{t('workflow.avg_duration')}</th>
											<th class="px-3 py-2 font-medium text-right">{t('workflow.avg_cost')}</th>
										</tr>
									</thead>
									<tbody>
										{#each sortedSteps as stat}
											{@const failRate = stat.total_runs > 0 ? (stat.fail_count / stat.total_runs) * 100 : 0}
											<tr class="border-t border-border hover:bg-bg-subtle/50">
												<td class="px-3 py-2 font-mono">{stat.step_id}</td>
												<td class="px-3 py-2 text-text-subtle">{stat.manifest_name}</td>
												<td class="px-3 py-2 text-right">{stat.total_runs}</td>
												<td class="px-3 py-2 text-right">
													<span class="inline-flex items-center gap-1 {failRate > 0 ? 'text-danger' : 'text-success'}">
														{#if failRate > 0}
															<span class="inline-block h-1.5 w-1.5 rounded-full bg-danger"></span>
														{/if}
														{failRate.toFixed(0)}%
													</span>
												</td>
												<td class="px-3 py-2 text-right font-mono">{formatDuration(stat.avg_duration_ms)}</td>
												<td class="px-3 py-2 text-right font-mono">{formatCost(stat.avg_cost_usd)}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
</div>
