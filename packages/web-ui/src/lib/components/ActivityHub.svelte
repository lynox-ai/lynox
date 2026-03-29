<script lang="ts">
	import { goto } from '$app/navigation';
	import { sendMessage } from '../stores/chat.svelte.js';
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import HistoryView from './HistoryView.svelte';
	import TasksView from './TasksView.svelte';

	let { onrerun }: { onrerun?: (task: string) => void } = $props();

	let tab = $state<'dashboard' | 'history' | 'tasks'>('dashboard');

	const tabs = [
		{ id: 'dashboard' as const, labelKey: 'hub.activity.dashboard' },
		{ id: 'history' as const, labelKey: 'hub.activity.history' },
		{ id: 'tasks' as const, labelKey: 'hub.activity.tasks' },
	];

	// ── Dashboard data ──────────────────────────────────
	interface Stats {
		total_runs?: number;
		total_cost_usd?: number;
		avg_duration_ms?: number;
		cost_by_model?: Array<{ model_id: string; cost_usd: number; run_count: number }>;
	}
	interface CostDay { day: string; cost_usd: number; run_count: number; }
	interface TaskRecord { id: string; title: string; status: string; priority?: string; assignee?: string; schedule_cron?: string; }

	let stats = $state<Stats | null>(null);
	let costDays = $state<CostDay[]>([]);
	let tasks = $state<TaskRecord[]>([]);
	let loading = $state(true);

	async function loadDashboard() {
		loading = true;
		try {
			const [statsRes, costRes, tasksRes] = await Promise.all([
				fetch(`${getApiBase()}/history/stats`),
				fetch(`${getApiBase()}/history/runs?limit=1`).then(() =>
					fetch(`${getApiBase()}/history/stats`)),
				fetch(`${getApiBase()}/tasks`),
			]);
			stats = (await statsRes.json()) as Stats;
			// Cost chart data
			try {
				const costResp = await fetch(`${getApiBase()}/history/costs?days=14`);
				if (costResp.ok) costDays = ((await costResp.json()) as { costs: CostDay[] }).costs ?? [];
			} catch { /* non-critical */ }
			const tasksData = (await tasksRes.json()) as { tasks: TaskRecord[] };
			tasks = tasksData.tasks;
		} catch { /* non-critical */ }
		loading = false;
	}

	$effect(() => {
		if (tab === 'dashboard') loadDashboard();
	});

	const openTasks = $derived(tasks.filter(t => t.status === 'open' || t.status === 'in_progress'));
	const scheduledTasks = $derived(tasks.filter(t => t.schedule_cron));
	const totalCost14d = $derived(costDays.reduce((s, d) => s + d.cost_usd, 0));
	const totalRuns14d = $derived(costDays.reduce((s, d) => s + d.run_count, 0));
	const maxCost = $derived(Math.max(...costDays.map(d => d.cost_usd), 0.01));

	function formatCost(usd: number): string {
		return `$${usd.toFixed(2)}`;
	}

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	function shortDay(iso: string): string {
		return new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' });
	}

	function rerun(task: string) {
		sendMessage(task);
		goto('/app');
	}
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center gap-1 px-5 py-3 border-b border-border shrink-0">
		{#each tabs as t_item}
			<button
				type="button"
				class="px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors {tab === t_item.id ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
				onclick={() => tab = t_item.id}
			>{t(t_item.labelKey)}</button>
		{/each}
	</div>
	<div class="flex-1 overflow-y-auto">
		{#if tab === 'dashboard'}
			<div class="overflow-y-auto h-full p-6 space-y-6 max-w-3xl mx-auto">
				{#if loading}
					<p class="text-text-muted text-sm">{t('common.loading')}</p>
				{:else}
					<!-- KPI Cards -->
					<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">Runs (14d)</p>
							<p class="text-2xl font-light text-text mt-1">{totalRuns14d}</p>
						</div>
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">Cost (14d)</p>
							<p class="text-2xl font-light text-text mt-1">{formatCost(totalCost14d)}</p>
						</div>
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('hub.activity.total_runs')}</p>
							<p class="text-2xl font-light text-text mt-1">{stats?.total_runs ?? 0}</p>
						</div>
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('hub.activity.avg_speed')}</p>
							<p class="text-2xl font-light text-text mt-1">{formatDuration(stats?.avg_duration_ms ?? 0)}</p>
						</div>
					</div>

					<!-- Cost Chart (14 days) -->
					{#if costDays.length > 0}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-3">{t('hub.activity.cost_chart')}</p>
							<div class="flex items-end gap-1 h-24">
								{#each costDays as day}
									<div class="flex-1 flex flex-col items-center gap-1 group relative">
										<div
											class="w-full rounded-t-sm bg-accent/60 hover:bg-accent transition-colors"
											style="height: {Math.max((day.cost_usd / maxCost) * 100, 2)}%"
										></div>
										<span class="text-[8px] text-text-subtle">{shortDay(day.day)}</span>
										<div class="absolute bottom-full mb-2 hidden group-hover:block bg-bg border border-border rounded-[var(--radius-sm)] px-2 py-1 text-[10px] text-text whitespace-nowrap z-10">
											{formatCost(day.cost_usd)} / {day.run_count} runs
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Model breakdown -->
					{#if stats?.cost_by_model && stats.cost_by_model.length > 0}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-3">{t('hub.activity.by_model')}</p>
							<div class="space-y-2">
								{#each stats.cost_by_model as model}
									<div class="flex items-center justify-between text-sm">
										<span class="text-text-muted font-mono text-xs">{model.model_id}</span>
										<span class="text-text">{formatCost(model.cost_usd)} <span class="text-text-subtle text-xs">({model.run_count} runs)</span></span>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Open Tasks -->
					{#if openTasks.length > 0}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<div class="flex items-center justify-between mb-3">
								<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('hub.activity.open_tasks')}</p>
								<button type="button" class="text-[10px] text-accent-text hover:opacity-80" onclick={() => tab = 'tasks'}>{t('hub.activity.view_all')}</button>
							</div>
							<div class="space-y-2">
								{#each openTasks.slice(0, 5) as task}
									<div class="flex items-center gap-2 text-sm">
										<span class="h-1.5 w-1.5 rounded-full {task.status === 'in_progress' ? 'bg-warning' : 'bg-text-subtle'}"></span>
										<span class="text-text flex-1 truncate">{task.title}</span>
										{#if task.assignee}
											<span class="text-[10px] text-text-subtle">@{task.assignee}</span>
										{/if}
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Scheduled Tasks -->
					{#if scheduledTasks.length > 0}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-3">{t('hub.activity.scheduled')}</p>
							<div class="space-y-2">
								{#each scheduledTasks.slice(0, 5) as task}
									<div class="flex items-center justify-between text-sm">
										<span class="text-text truncate">{task.title}</span>
										<span class="text-[10px] font-mono text-text-subtle">{task.schedule_cron}</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{/if}
			</div>
		{:else if tab === 'history'}
			<HistoryView {onrerun} />
		{:else}
			<TasksView />
		{/if}
	</div>
</div>
