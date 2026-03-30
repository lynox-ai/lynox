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
		last_run_status?: string;
		priority?: string;
		assignee?: string;
	}

	let tasks = $state<TaskRecord[]>([]);
	let loading = $state(true);
	let newTitle = $state('');
	let newSchedule = $state('');
	let newAssignee = $state('lynox');
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
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/tasks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: newTitle,
					description: newTitle,
					assignee: newAssignee || undefined,
					scheduleCron: newSchedule || undefined
				})
			});
			if (!res.ok) throw new Error();
			newTitle = '';
			newSchedule = '';
			await loadTasks();
		} catch {
			error = t('common.save_failed');
		}
	}

	async function deleteTask(id: string) {
		try {
			await fetch(`${getApiBase()}/tasks/${id}`, { method: 'DELETE' });
			await loadTasks();
		} catch { error = t('common.save_failed'); }
	}

	async function markDone(id: string) {
		try {
			await fetch(`${getApiBase()}/tasks/${id}/complete`, { method: 'POST' });
			await loadTasks();
		} catch { error = t('common.save_failed'); }
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

	const statusLabel: Record<string, string> = {
		open: 'Offen', in_progress: 'Aktiv', completed: 'Erledigt', done: 'Erledigt',
	};

	const statusColor: Record<string, string> = {
		open: 'bg-bg-muted text-text-muted',
		in_progress: 'bg-warning/15 text-warning',
		completed: 'bg-success/15 text-success',
		done: 'bg-success/15 text-success',
	};

	$effect(() => { loadTasks(); });
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
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3 group">
					<div class="flex items-center justify-between gap-3">
						<div class="flex-1 min-w-0">
							<p class="text-sm font-medium truncate">{task.title}</p>
							<div class="flex flex-wrap gap-2 mt-1.5 text-xs text-text-subtle">
								{#if task.schedule_cron}
									<span class="flex items-center gap-1">
										<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
										{cronToHuman(task.schedule_cron)}
									</span>
								{/if}
								{#if task.next_run_at}
									<span>{t('tasks.next_run')}: {new Date(task.next_run_at).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })}</span>
								{/if}
								{#if task.assignee}
									<span class="text-accent-text">@{task.assignee}</span>
								{/if}
							</div>
						</div>
						<div class="flex items-center gap-2 shrink-0">
							{#if task.status !== 'completed' && task.status !== 'done'}
								<button onclick={() => markDone(task.id)} class="opacity-0 group-hover:opacity-100 rounded-[var(--radius-sm)] border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] text-success hover:bg-success/20 transition-all">{t('tasks.done')}</button>
							{/if}
							<button onclick={() => deleteTask(task.id)} class="opacity-0 group-hover:opacity-100 rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/20 transition-all">{t('tasks.delete')}</button>
							<span class="text-xs rounded-full px-2.5 py-0.5 {statusColor[task.status] ?? 'bg-bg-muted text-text-muted'}">{statusLabel[task.status] ?? task.status}</span>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="text-center py-12 text-text-subtle">
			<p class="text-sm">{t('tasks.no_tasks')}</p>
			<p class="text-xs mt-2">{t('tasks.no_tasks_hint')}</p>
		</div>
	{/if}

	<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle p-4 space-y-3">
		<h2 class="text-sm font-medium">{t('tasks.create_title')}</h2>
		<input
			bind:value={newTitle}
			placeholder={t('tasks.description_placeholder')}
			class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-[16px] md:text-sm focus:border-accent focus:outline-none"
		/>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label for="task-assignee" class="text-xs text-text-subtle mb-1 block">{t('tasks.who')}</label>
				<select id="task-assignee" bind:value={newAssignee} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none">
					<option value="lynox">{t('tasks.assignee_lynox')}</option>
					<option value="user">{t('tasks.assignee_user')}</option>
				</select>
			</div>
			<div>
				<label for="task-schedule" class="text-xs text-text-subtle mb-1 block">{t('tasks.repeat')}</label>
				<select id="task-schedule" bind:value={newSchedule} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none">
					<option value="">{t('tasks.once')}</option>
					<option value="0 * * * *">{t('tasks.every_hour')}</option>
					<option value="0 9 * * *">{t('tasks.preset_daily')}</option>
					<option value="0 9 * * 1">{t('tasks.preset_weekly')}</option>
					<option value="0 9 1 * *">{t('tasks.preset_monthly')}</option>
				</select>
			</div>
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
