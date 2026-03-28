<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.js';

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

	async function loadTasks() {
		loading = true;
		const res = await fetch(`${getApiBase()}/tasks`);
		const data = (await res.json()) as { tasks: TaskRecord[] };
		tasks = data.tasks;
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
	<h1 class="text-xl font-bold mb-4">{t('tasks.title')}</h1>

	{#if loading}
		<p class="text-text-subtle text-sm mb-4">{t('common.loading')}</p>
	{:else if tasks.length > 0}
		<div class="space-y-2 mb-6">
			{#each tasks as task}
				<div class="rounded-lg border border-border bg-bg-subtle px-4 py-3">
					<div class="flex items-center justify-between">
						<span class="text-sm font-medium">{task.title}</span>
						<span class="text-xs rounded bg-bg-muted px-1.5 py-0.5 text-text-muted">{task.status}</span>
					</div>
					{#if task.schedule_cron}
						<p class="text-xs text-text-subtle mt-1 font-mono">{task.schedule_cron}</p>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<p class="text-text-subtle text-sm mb-4">{t('tasks.no_tasks')}</p>
	{/if}

	<div class="rounded-lg border border-border bg-bg-subtle p-4 space-y-3">
		<h2 class="text-sm font-medium">{t('tasks.create_title')}</h2>
		<input
			bind:value={newTitle}
			placeholder={t('tasks.description_placeholder')}
			class="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none"
		/>
		<input
			bind:value={newSchedule}
			placeholder={t('tasks.cron_placeholder')}
			class="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
		/>
		<button
			onclick={createTask}
			disabled={!newTitle.trim()}
			class="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
		>
			{t('tasks.create')}
		</button>
	</div>
</div>
