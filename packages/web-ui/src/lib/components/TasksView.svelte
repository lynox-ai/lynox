<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';

	interface TaskRecord {
		id: string;
		title: string;
		status: string;
		schedule_cron?: string;
		next_run_at?: string;
		last_run_at?: string;
	}

	let tasks = $state<TaskRecord[]>([]);
	let loading = $state(true);
	let newTitle = $state('');
	let newSchedule = $state('');
	let error = $state('');

	async function loadTasks() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/tasks`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { tasks: TaskRecord[] };
			tasks = data.tasks;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	async function createTask() {
		if (!newTitle.trim()) return;
		await fetch(`${getApiBase()}/tasks`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: newTitle,
				description: newTitle,
				scheduleCron: newSchedule || undefined
			})
		});
		newTitle = '';
		newSchedule = '';
		await loadTasks();
	}

	$effect(() => {
		loadTasks();
	});
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 class="text-xl font-light tracking-tight mb-4">{t('tasks.title')}</h1>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm mb-4">{t('common.loading')}</p>
	{:else if tasks.length > 0}
		<div class="space-y-2 mb-6">
			{#each tasks as task}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3">
					<div class="flex items-center justify-between">
						<span class="text-sm font-medium">{task.title}</span>
						<span class="text-xs rounded-[var(--radius-sm)] px-1.5 py-0.5 {task.status === 'completed' ? 'bg-success/15 text-success' : task.status === 'in_progress' ? 'bg-warning/15 text-warning' : 'bg-bg-muted text-text-muted'}">{task.status}</span>
					</div>
					<div class="flex flex-wrap gap-3 mt-1.5 text-xs text-text-subtle">
						{#if task.schedule_cron}
							<span class="font-mono">{task.schedule_cron}</span>
						{/if}
						{#if task.next_run_at}
							<span>{t('tasks.next_run')}: {new Date(task.next_run_at).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })}</span>
						{/if}
						{#if task.last_run_at}
							<span>{t('tasks.last_run')}: {new Date(task.last_run_at).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })}</span>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-text-subtle text-sm mb-4">{t('tasks.no_tasks')}</p>
	{/if}

	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-3">
		<h2 class="text-sm font-medium">{t('tasks.create_title')}</h2>
		<input
			bind:value={newTitle}
			placeholder={t('tasks.description_placeholder')}
			class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
		/>
		<input
			bind:value={newSchedule}
			placeholder={t('tasks.cron_placeholder')}
			class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
		/>
		<div class="flex items-center gap-2 flex-wrap">
			<span class="text-xs text-text-subtle">{t('tasks.presets')}</span>
			<button type="button" onclick={() => newSchedule = '0 9 * * *'} class="rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all">{t('tasks.preset_daily')}</button>
			<button type="button" onclick={() => newSchedule = '0 9 * * 1'} class="rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all">{t('tasks.preset_weekly')}</button>
			<button type="button" onclick={() => newSchedule = '0 * * * *'} class="rounded-[var(--radius-sm)] border border-border px-2 py-0.5 text-xs text-text-muted hover:text-text hover:border-border-hover transition-all">{t('tasks.preset_hourly')}</button>
		</div>
		<button
			onclick={createTask}
			disabled={!newTitle.trim()}
			class="rounded-[var(--radius-sm)] bg-accent px-4 py-2 text-sm font-medium text-text hover:opacity-90 disabled:opacity-50"
		>
			{t('tasks.create')}
		</button>
	</div>
</div>
