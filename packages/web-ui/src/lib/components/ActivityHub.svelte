<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { sendMessage } from '../stores/chat.svelte.js';
	import { getApiBase } from '../config.svelte.js';
	import { formatCost, formatDuration, shortModel } from '../format.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import HistoryView from './HistoryView.svelte';
	import TasksView from './TasksView.svelte';
	import UsageDashboard from './UsageDashboard.svelte';

	let { onrerun }: { onrerun?: (task: string) => void } = $props();

	let tab = $state<'dashboard' | 'usage' | 'history' | 'tasks'>('dashboard');

	$effect(() => {
		const p = $page.url.searchParams.get('tab');
		if (p === 'usage' || p === 'history' || p === 'tasks') tab = p;
		else tab = 'dashboard';
	});

	const tabs = [
		{ id: 'dashboard' as const, labelKey: 'hub.activity.dashboard' },
		{ id: 'usage' as const,     labelKey: 'hub.activity.usage' },
		{ id: 'history' as const,   labelKey: 'hub.activity.history' },
		{ id: 'tasks' as const,     labelKey: 'hub.activity.tasks' },
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
	interface Pattern { id: string; patternType: string; description: string; evidenceCount: number; confidence: number; }
	interface ThreadInsight {
		sessionId: string;
		title: string;
		runCount: number;
		successCount: number;
		failedCount: number;
		totalDurationMs: number;
		totalCostUsd: number;
		lastRunAt: string;
		toolCounts: Record<string, number>;
	}

	function cronToHuman(cron: string): string {
		if (cron === '0 * * * *') return t('tasks.every_hour');
		const m = cron.match(/^(\d+)\s+(\d+)\s+(\*|\d+)\s+\*\s+(\*|\d+)$/);
		if (!m) return cron;
		const hour = m[2];
		const day = m[3];
		const weekday = m[4];
		const weekdays: Record<string, string> = { '0': t('tasks.sunday'), '1': t('tasks.monday'), '2': t('tasks.tuesday'), '3': t('tasks.wednesday'), '4': t('tasks.thursday'), '5': t('tasks.friday'), '6': t('tasks.saturday') };
		if (day !== '*') return `${t('tasks.monthly_on')} ${day}. ${t('tasks.at')} ${hour}:${m[1]?.padStart(2, '0')}`;
		if (weekday !== '*') return `${weekdays[weekday] ?? weekday} ${hour}:${m[1]?.padStart(2, '0')}`;
		return `${t('tasks.daily_at')} ${hour}:${m[1]?.padStart(2, '0')}`;
	}

	let stats = $state<Stats | null>(null);
	let costDays = $state<CostDay[]>([]);
	let tasks = $state<TaskRecord[]>([]);
	let patterns = $state<Pattern[]>([]);
	let threadInsights = $state<ThreadInsight[]>([]);
	let loading = $state(true);

	async function loadDashboard() {
		loading = true;
		try {
			const [statsRes, costRes, tasksRes, patternsRes, threadsRes] = await Promise.all([
				fetch(`${getApiBase()}/history/stats`),
				fetch(`${getApiBase()}/history/cost/daily?days=14`),
				fetch(`${getApiBase()}/tasks`),
				fetch(`${getApiBase()}/patterns`).catch(() => null),
				fetch(`${getApiBase()}/thread-insights?limit=10`).catch(() => null),
			]);
			stats = (await statsRes.json()) as Stats;
			if (costRes.ok) costDays = (await costRes.json()) as CostDay[];
			const tasksData = (await tasksRes.json()) as { tasks: TaskRecord[] };
			tasks = tasksData.tasks;
			if (patternsRes?.ok) patterns = ((await patternsRes.json()) as { patterns: Pattern[] }).patterns;
			if (threadsRes?.ok) threadInsights = ((await threadsRes.json()) as { threadInsights: ThreadInsight[] }).threadInsights;
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

	const patternTypeColor: Record<string, string> = {
		sequence: 'bg-accent/15 text-accent-text',
		preference: 'bg-success/15 text-success',
		'anti-pattern': 'bg-danger/15 text-danger',
		schedule: 'bg-warning/15 text-warning',
	};

	function shortDay(iso: string): string {
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
	}

	function successRate(ti: ThreadInsight): number {
		return ti.runCount > 0 ? ti.successCount / ti.runCount : 0;
	}

	function topTools(toolMap: Record<string, number> | undefined | null, max = 3): string[] {
		if (!toolMap) return [];
		return Object.entries(toolMap)
			.sort((a, b) => b[1] - a[1])
			.slice(0, max)
			.map(([k]) => k);
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
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('hub.activity.runs_period').replace('{days}', '14')}</p>
							<p class="text-2xl font-light text-text mt-1">{totalRuns14d}</p>
						</div>
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('hub.activity.cost_period').replace('{days}', '14')}</p>
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
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 overflow-hidden">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-3">{t('hub.activity.cost_chart')}</p>
							<div class="flex gap-0.5 sm:gap-1 h-24 overflow-x-auto scrollbar-none">
								{#each costDays as day (day.day)}
									<div class="flex-1 flex flex-col items-center gap-1 group relative">
										<div class="flex-1 w-full flex items-end">
											<div
												class="w-full rounded-t-sm bg-accent/60 hover:bg-accent transition-colors"
												style="height: {Math.max((day.cost_usd / maxCost) * 100, 2)}%"
											></div>
										</div>
										<span class="text-[8px] text-text-subtle shrink-0">{shortDay(day.day)}</span>
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
								{#each stats.cost_by_model as model (model.model_id)}
									<div class="flex items-center justify-between text-sm">
										<span class="text-text-muted font-mono text-xs">{shortModel(model.model_id)}</span>
										<span class="text-text">{formatCost(model.cost_usd)} <span class="text-text-subtle text-xs">({model.run_count} runs)</span></span>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Thread Performance -->
					{#if threadInsights.length > 0}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-3">{t('hub.activity.thread_insights')}</p>
							<div class="space-y-1">
								{#each threadInsights as ti}
									<div class="rounded-[var(--radius-sm)] border border-border px-3 py-2 flex items-center gap-3">
										<div class="shrink-0 w-8 text-center">
											<span class="text-xs font-mono {successRate(ti) >= 0.6 ? 'text-success' : successRate(ti) >= 0.3 ? 'text-warning' : 'text-danger'}">
												{(successRate(ti) * 100).toFixed(0)}%
											</span>
										</div>
										<div class="flex-1 min-w-0">
											<p class="text-sm truncate">{(ti.title || 'Untitled').slice(0, 80)}</p>
											<div class="flex gap-2 text-[10px] text-text-subtle mt-0.5 overflow-hidden">
												<span class="font-mono shrink-0">{ti.runCount} runs</span>
												{#each topTools(ti.toolCounts) as tool}
													<span class="bg-bg-muted px-1.5 py-0.5 rounded truncate">{tool}</span>
												{/each}
											</div>
										</div>
										<div class="text-right shrink-0 text-xs text-text-subtle tabular-nums">
											<p>{formatDuration(ti.totalDurationMs)}</p>
											<p>{formatCost(ti.totalCostUsd)}</p>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}

					<!-- Detected Patterns -->
					{#if patterns.length > 0}
						<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4">
							<p class="text-[10px] font-mono uppercase tracking-widest text-text-subtle mb-3">{t('hub.activity.patterns')}</p>
							<div class="space-y-2">
								{#each patterns.slice(0, 5) as pattern}
									<div class="rounded-[var(--radius-sm)] border border-border px-3 py-2">
										<div class="flex items-center gap-2 mb-1">
											<span class="text-[10px] rounded-full px-2 py-0.5 font-mono {patternTypeColor[pattern.patternType] ?? 'bg-bg-muted text-text-muted'}">{pattern.patternType}</span>
											<span class="text-[10px] text-text-subtle">{t('hub.activity.confidence')}: {(pattern.confidence * 100).toFixed(0)}%</span>
											<span class="text-[10px] text-text-subtle">{t('hub.activity.evidence')}: {pattern.evidenceCount}x</span>
										</div>
										<p class="text-xs text-text-muted">{pattern.description}</p>
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
										<span class="text-text flex-1 line-clamp-2 break-words">{task.title}</span>
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
										<span class="text-text min-w-0 line-clamp-2 break-words">{task.title}</span>
										<span class="text-[10px] text-text-subtle">{cronToHuman(task.schedule_cron ?? '')}</span>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{/if}
			</div>
		{:else if tab === 'usage'}
			<!-- Reuses the same UsageDashboard component that Settings → Budget & Usage
			     renders. Two entry points, one surface — status bar "$X today" link
			     points here too so the most-clicked cost path lands on the dashboard
			     instead of the raw run history. -->
			<div class="p-6 max-w-3xl mx-auto">
				<UsageDashboard />
			</div>
		{:else if tab === 'history'}
			<HistoryView {onrerun} />
		{:else}
			<TasksView />
		{/if}
	</div>
</div>
