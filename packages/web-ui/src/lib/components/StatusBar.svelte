<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { onDestroy } from 'svelte';

	let engineOk = $state<boolean | null>(null);
	let activeTasks = $state(0);
	let dailyCost = $state(0);
	let totalRuns = $state(0);

	async function poll() {
		try {
			const [healthRes, tasksRes, costRes] = await Promise.all([
				fetch(`${getApiBase()}/health`).catch(() => null),
				fetch(`${getApiBase()}/tasks?status=in_progress`).catch(() => null),
				fetch(`${getApiBase()}/history/stats`).catch(() => null),
			]);

			engineOk = healthRes?.ok ?? false;

			if (tasksRes?.ok) {
				const data = (await tasksRes.json()) as { tasks: unknown[] };
				activeTasks = data.tasks.length;
			}

			if (costRes?.ok) {
				const data = (await costRes.json()) as { total_runs?: number; total_cost_usd?: number };
				totalRuns = data.total_runs ?? 0;
				dailyCost = data.total_cost_usd ?? 0;
			}
		} catch { /* silent */ }
	}

	poll();
	const interval = setInterval(poll, 30_000);
	onDestroy(() => clearInterval(interval));
</script>

<div class="hidden md:flex items-center gap-px border-t border-border bg-bg-subtle text-[11px] font-mono text-text-subtle h-8 px-1 overflow-x-auto scrollbar-none">
	<!-- Engine Status -->
	<a href="/app" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		<span class="inline-block h-1.5 w-1.5 rounded-full {engineOk === true ? 'bg-success' : engineOk === false ? 'bg-danger' : 'bg-text-subtle animate-pulse'}"></span>
		{engineOk === true ? t('status.engine_ok') : engineOk === false ? t('status.engine_error') : '...'}
	</a>

	<span class="text-border">|</span>

	<!-- Active Tasks -->
	<a href="/app/tasks" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		<span class="text-accent-text">{activeTasks}</span> {t('status.tasks_active')}
	</a>

	<span class="text-border">|</span>

	<!-- Total Runs -->
	<a href="/app/history" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		{totalRuns} {t('status.runs')}
	</a>

	<span class="text-border">|</span>

	<!-- Daily Cost -->
	<a href="/app/history" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		${dailyCost.toFixed(2)} {t('status.today')}
	</a>
</div>
