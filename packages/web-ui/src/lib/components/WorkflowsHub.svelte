<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import WorkflowsView from './WorkflowsView.svelte';

	interface CostStat {
		manifest_name: string;
		run_count: number;
		avg_cost_usd: number;
		total_cost_usd: number;
		avg_duration_ms: number;
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

	let tab = $state<'list' | 'analytics'>('list');
	let costStats = $state<CostStat[]>([]);
	let stepStats = $state<StepStat[]>([]);
	let statsLoading = $state(false);

	async function loadStats() {
		statsLoading = true;
		try {
			const [costRes, stepRes] = await Promise.all([
				fetch(`${getApiBase()}/pipelines/stats/cost?days=30`),
				fetch(`${getApiBase()}/pipelines/stats/steps?days=30`),
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

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${(ms / 60_000).toFixed(1)}m`;
	}

	function formatCost(usd: number): string {
		return `$${usd.toFixed(4)}`;
	}

	$effect(() => {
		if (tab === 'analytics') loadStats();
	});
</script>

<div class="flex flex-col h-full">
	<!-- Tab buttons -->
	<div class="flex items-center gap-1 px-5 py-3 border-b border-border">
		{#each tabs as t_item}
			<button
				class="px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors
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
				<h1 class="text-xl font-light tracking-tight">{t('workflow.analytics_title')}</h1>

				{#if statsLoading}
					<p class="text-text-subtle text-sm">{t('common.loading')}</p>
				{:else if costStats.length === 0 && stepStats.length === 0}
					<div class="text-center py-12 text-text-subtle">
						<p class="text-sm">{t('workflow.no_analytics')}</p>
					</div>
				{:else}
					<!-- Cost by workflow -->
					{#if costStats.length > 0}
						<div>
							<h2 class="text-xs font-medium uppercase tracking-widest text-text-subtle mb-3">{t('workflow.cost_by_workflow')}</h2>
							<div class="space-y-2">
								{#each costStats as stat}
									<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
										<div class="flex items-center justify-between">
											<p class="text-sm font-medium">{stat.manifest_name}</p>
											<span class="text-xs font-mono text-text-subtle">{stat.run_count} {t('workflow.runs')}</span>
										</div>
										<div class="flex gap-4 mt-1.5 text-xs text-text-subtle">
											<span>{t('workflow.total_cost')}: {formatCost(stat.total_cost_usd)}</span>
											<span>{t('workflow.avg_cost')}: {formatCost(stat.avg_cost_usd)}</span>
											<span>{t('workflow.avg_duration')}: {formatDuration(stat.avg_duration_ms)}</span>
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
										{#each stepStats as stat}
											<tr class="border-t border-border hover:bg-bg-subtle/50">
												<td class="px-3 py-2 font-mono">{stat.step_id}</td>
												<td class="px-3 py-2 text-text-subtle">{stat.manifest_name}</td>
												<td class="px-3 py-2 text-right">{stat.total_runs}</td>
												<td class="px-3 py-2 text-right {stat.fail_count > 0 ? 'text-danger' : 'text-success'}">
													{stat.total_runs > 0 ? ((stat.fail_count / stat.total_runs) * 100).toFixed(0) : 0}%
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
