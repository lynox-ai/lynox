<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { onDestroy } from 'svelte';

	let engineOk = $state<boolean | null>(null);
	let activeTasks = $state(0);
	let todayCost = $state(0);
	let todayRuns = $state(0);

	async function poll() {
		try {
			const [healthRes, tasksRes, dailyRes] = await Promise.all([
				fetch(`${getApiBase()}/health`).catch(() => null),
				fetch(`${getApiBase()}/tasks?status=in_progress`).catch(() => null),
				fetch(`${getApiBase()}/history/cost/daily?days=1`).catch(() => null),
			]);

			engineOk = healthRes?.ok ?? false;

			if (tasksRes?.ok) {
				const data = (await tasksRes.json()) as { tasks: unknown[] };
				activeTasks = data.tasks.length;
			}

			if (dailyRes?.ok) {
				const rows = (await dailyRes.json()) as Array<{ day: string; cost_usd: number; run_count: number }>;
				const today = new Date().toISOString().slice(0, 10);
				const todayRow = rows.find(r => r.day === today);
				todayCost = todayRow?.cost_usd ?? 0;
				todayRuns = todayRow?.run_count ?? 0;
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

	<!-- Today's Cost -->
	<a href="/app/history" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		${todayCost.toFixed(2)} {t('status.today')}
	</a>

	<span class="text-border">|</span>

	<!-- Today's Runs -->
	<a href="/app/history" class="flex items-center gap-1.5 px-3 py-1 hover:text-text transition-colors shrink-0">
		{todayRuns} {t('status.runs')} {t('status.today')}
	</a>
</div>
