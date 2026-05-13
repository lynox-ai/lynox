<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import Icon from '../primitives/Icon.svelte';

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
		task_type?: string;
	}

	interface Props {
		/** Hide rows whose task_type doesn't match. When unset, show all
		 *  (the legacy "everything" view); when set to 'reminder', the
		 *  AutomationHub Reminders tab passes 'reminder' to scope the list. */
		filterTaskType?: string | undefined;
	}

	const { filterTaskType }: Props = $props();

	type Frequency = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly';

	let tasks = $state<TaskRecord[]>([]);
	let loading = $state(true);
	let newTitle = $state('');
	let newAssignee = $state('lynox');
	let frequency = $state<Frequency>('once');
	let timeStr = $state('09:00');
	let dateStr = $state('');                 // YYYY-MM-DD for "once"
	let weekdayStr = $state('1');             // 0-6 Sun..Sat (cron convention)
	let dayOfMonthStr = $state('1');          // 1-31
	let error = $state('');

	// Default the once-date to tomorrow on first render so the form is usable immediately.
	$effect(() => {
		if (!dateStr) {
			const t0 = new Date();
			t0.setDate(t0.getDate() + 1);
			dateStr = t0.toISOString().slice(0, 10);
		}
	});

	async function loadTasks() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/tasks`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { tasks: TaskRecord[] };
			// Client-side filter — the /api/tasks endpoint doesn't yet
			// support a task_type query param. Cheap on the typical
			// <100 task volume; revisit if it grows.
			tasks = filterTaskType !== undefined
				? data.tasks.filter((task) => (task.task_type ?? '') === filterTaskType)
				: data.tasks;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	// Convert a local "HH:MM" string into UTC {hh, mm} used by the cron parser
	// (which iterates UTC). Anchored to today's date so DST matches when the
	// task next fires; cross-midnight TZ shifts (e.g. APAC users) may pick a
	// neighboring weekday — acceptable trade-off to keep the cron string flat.
	function localTimeToUtcParts(hm: string): { hh: number; mm: number } {
		const [h, m] = hm.split(':').map((n) => parseInt(n, 10));
		const local = new Date();
		local.setHours(h ?? 0, m ?? 0, 0, 0);
		return { hh: local.getUTCHours(), mm: local.getUTCMinutes() };
	}

	function buildSchedulePayload(): { scheduleCron?: string; runAt?: string; error?: string } {
		if (frequency === 'once') {
			if (!dateStr || !timeStr) return { error: t('tasks.invalid_date') };
			const local = new Date(`${dateStr}T${timeStr}:00`);
			if (Number.isNaN(local.getTime()) || local.getTime() <= Date.now()) {
				return { error: t('tasks.invalid_date') };
			}
			return { runAt: local.toISOString() };
		}
		if (frequency === 'hourly') return { scheduleCron: '0 * * * *' };
		const { hh, mm } = localTimeToUtcParts(timeStr);
		if (frequency === 'daily') return { scheduleCron: `${mm} ${hh} * * *` };
		if (frequency === 'weekly') return { scheduleCron: `${mm} ${hh} * * ${weekdayStr}` };
		if (frequency === 'monthly') return { scheduleCron: `${mm} ${hh} ${dayOfMonthStr} * *` };
		return {};
	}

	async function createTask() {
		if (!newTitle.trim()) return;
		error = '';
		const payload = buildSchedulePayload();
		if (payload.error) { error = payload.error; return; }
		try {
			const res = await fetch(`${getApiBase()}/tasks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					title: newTitle,
					assignee: newAssignee || undefined,
					...(payload.scheduleCron ? { scheduleCron: payload.scheduleCron } : {}),
					...(payload.runAt ? { runAt: payload.runAt } : {}),
				})
			});
			if (!res.ok) {
				const msg = await res.json().catch(() => null) as { error?: string } | null;
				error = msg?.error ?? t('common.save_failed');
				return;
			}
			newTitle = '';
			frequency = 'once';
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

	// Render a UTC cron in the user's local time so "0 7 * * *" (created locally
	// as 09:00 in CEST) displays back as "Täglich um 09:00" instead of "07:00".
	function utcHmToLocal(mmStr: string, hhStr: string): string {
		const mm = parseInt(mmStr, 10);
		const hh = parseInt(hhStr, 10);
		if (Number.isNaN(mm) || Number.isNaN(hh)) return `${hhStr}:${mmStr.padStart(2, '0')}`;
		const d = new Date();
		d.setUTCHours(hh, mm, 0, 0);
		const pad = (n: number) => n.toString().padStart(2, '0');
		return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	function cronToHuman(cron: string): string {
		if (cron === '0 * * * *') return t('tasks.every_hour');
		const m = cron.match(/^(\d+)\s+(\d+)\s+(\*|\d+)\s+\*\s+(\*|\d+)$/);
		if (!m) return cron;
		const local = utcHmToLocal(m[1] ?? '0', m[2] ?? '0');
		const day = m[3];
		const weekday = m[4];
		const weekdays: Record<string, string> = { '0': t('tasks.sunday'), '1': t('tasks.monday'), '2': t('tasks.tuesday'), '3': t('tasks.wednesday'), '4': t('tasks.thursday'), '5': t('tasks.friday'), '6': t('tasks.saturday') };
		if (day !== '*') return `${t('tasks.monthly_on')} ${day}. ${t('tasks.at')} ${local}`;
		if (weekday !== '*') return `${weekdays[weekday] ?? weekday} ${local}`;
		return `${t('tasks.daily_at')} ${local}`;
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
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<h1 class="text-xl font-light tracking-tight mb-4 mt-2">{t('tasks.title')}</h1>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm mb-4">{t('common.loading')}</p>
	{:else if tasks.length > 0}
		<div class="space-y-2 mb-6">
			{#each tasks as task}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3 group">
					<div class="flex items-start justify-between gap-3">
						<div class="flex-1 min-w-0">
							<p class="text-sm font-medium line-clamp-2 break-words">{task.title}</p>
							<div class="flex flex-wrap gap-2 mt-1.5 text-xs text-text-subtle">
								{#if task.schedule_cron}
									<span class="flex items-center gap-1">
										<Icon name="clock" size="xs" />
										{cronToHuman(task.schedule_cron)}
									</span>
								{/if}
								{#if task.status === 'completed' || task.status === 'done'}
									{#if task.last_run_at ?? task.next_run_at}
										<span>{t('tasks.last_run')}: {new Date((task.last_run_at ?? task.next_run_at)!).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
									{/if}
								{:else if task.next_run_at}
									<span>{t('tasks.next_run')}: {new Date(task.next_run_at).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
								{/if}
								{#if task.assignee}
									<span class="text-accent-text">@{task.assignee}</span>
								{/if}
							</div>
						</div>
						<div class="flex items-center gap-2 shrink-0 mt-0.5">
							{#if task.status !== 'completed' && task.status !== 'done'}
								<button onclick={() => markDone(task.id)} class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-success/30 bg-success/10 px-2 py-0.5 text-[10px] text-success hover:bg-success/20 transition-opacity">{t('tasks.done')}</button>
							{/if}
							<button onclick={() => deleteTask(task.id)} class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/20 transition-opacity">{t('tasks.delete')}</button>
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
				<label for="task-frequency" class="text-xs text-text-subtle mb-1 block">{t('tasks.repeat')}</label>
				<select id="task-frequency" bind:value={frequency} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none">
					<option value="once">{t('tasks.once')}</option>
					<option value="hourly">{t('tasks.every_hour')}</option>
					<option value="daily">{t('tasks.frequency_daily')}</option>
					<option value="weekly">{t('tasks.frequency_weekly')}</option>
					<option value="monthly">{t('tasks.frequency_monthly')}</option>
				</select>
			</div>
		</div>

		<!-- Conditional pickers driven by frequency -->
		{#if frequency === 'once'}
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label for="task-date" class="text-xs text-text-subtle mb-1 block">{t('tasks.date_label')}</label>
					<input id="task-date" type="date" bind:value={dateStr} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none" />
				</div>
				<div>
					<label for="task-time-once" class="text-xs text-text-subtle mb-1 block">{t('tasks.time_label')}</label>
					<input id="task-time-once" type="time" bind:value={timeStr} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none" />
				</div>
			</div>
		{:else if frequency === 'daily'}
			<div>
				<label for="task-time-daily" class="text-xs text-text-subtle mb-1 block">{t('tasks.time_label')}</label>
				<input id="task-time-daily" type="time" bind:value={timeStr} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none" />
			</div>
		{:else if frequency === 'weekly'}
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label for="task-weekday" class="text-xs text-text-subtle mb-1 block">{t('tasks.weekday_label')}</label>
					<select id="task-weekday" bind:value={weekdayStr} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none">
						<option value="1">{t('tasks.monday')}</option>
						<option value="2">{t('tasks.tuesday')}</option>
						<option value="3">{t('tasks.wednesday')}</option>
						<option value="4">{t('tasks.thursday')}</option>
						<option value="5">{t('tasks.friday')}</option>
						<option value="6">{t('tasks.saturday')}</option>
						<option value="0">{t('tasks.sunday')}</option>
					</select>
				</div>
				<div>
					<label for="task-time-weekly" class="text-xs text-text-subtle mb-1 block">{t('tasks.time_label')}</label>
					<input id="task-time-weekly" type="time" bind:value={timeStr} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none" />
				</div>
			</div>
		{:else if frequency === 'monthly'}
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label for="task-dom" class="text-xs text-text-subtle mb-1 block">{t('tasks.day_of_month_label')}</label>
					<select id="task-dom" bind:value={dayOfMonthStr} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none">
						{#each Array(31) as _, i}
							<option value={String(i + 1)}>{i + 1}.</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="task-time-monthly" class="text-xs text-text-subtle mb-1 block">{t('tasks.time_label')}</label>
					<input id="task-time-monthly" type="time" bind:value={timeStr} class="w-full rounded-[var(--radius-md)] border border-border bg-bg px-3 py-2 text-sm focus:border-accent focus:outline-none" />
				</div>
			</div>
		{/if}

		<div class="flex items-center gap-3 flex-wrap">
			<button
				onclick={createTask}
				disabled={!newTitle.trim()}
				class="rounded-[var(--radius-sm)] px-4 py-2 text-sm font-medium transition-colors enabled:bg-accent enabled:text-text enabled:hover:opacity-90 disabled:bg-bg-muted disabled:text-text-subtle disabled:cursor-not-allowed"
			>
				{t('tasks.create')}
			</button>
			{#if !newTitle.trim()}
				<span class="text-xs text-text-subtle">{t('tasks.title_required_hint')}</span>
			{/if}
		</div>
	</div>
</div>
