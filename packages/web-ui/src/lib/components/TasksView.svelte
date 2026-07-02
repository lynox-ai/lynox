<script lang="ts">
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { t, getLocale } from '../i18n.svelte.js';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import { sanitizeFramingField } from '../utils/chat-framing.js';
	import Icon from '../primitives/Icon.svelte';

	// User-TODOs only. Agent-triggers (cron/watch/pipeline/reminder/backup) live
	// in their own home now (TriggersView) — the v42 storage split is finished
	// in the UI too, so this view is the to-do list it is named for, not a
	// merged everything-list.
	interface TaskRecord {
		id: string;
		title: string;
		status: string;
		next_run_at?: string;
		last_run_at?: string;
		last_run_status?: string;
		priority?: string;
		assignee?: string;
	}

	let tasks = $state<TaskRecord[]>([]);
	let loading = $state(true);
	let error = $state('');

	// Tasks are created and managed by talking to the agent (task_create /
	// task_update), not a bespoke form — the chat is the editor. "New task"
	// opens a fresh chat to create one; per-row "Manage in chat" seeds it with
	// the task id so the agent can edit or reschedule it. The title is user/
	// agent-authored, so it passes through the client-side sanitiser first.
	function createInChat(): void {
		newChat();
		void sendMessage(t('tasks.create_in_chat_prompt'));
		void goto('/app');
	}

	function manageInChat(task: TaskRecord): void {
		newChat();
		const title = sanitizeFramingField(task.title);
		const id = sanitizeFramingField(task.id, 80);
		void sendMessage(`${t('tasks.manage_in_chat_prompt')} "${title}" (id: ${id}).`);
		void goto('/app');
	}

	async function loadTasks() {
		loading = true;
		error = '';
		try {
			// User-TODOs only (`/api/tasks`). Agent-triggers (`/api/triggers`) have
			// their own home (the Triggers tab) — the v42 split is reflected here.
			const res = await fetch(`${getApiBase()}/tasks`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { tasks: TaskRecord[] };
			tasks = data.tasks;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
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

	const statusLabel: Record<string, string> = {
		open: 'Offen', in_progress: 'Aktiv', completed: 'Erledigt', done: 'Erledigt',
		failed: 'Fehlgeschlagen',
	};

	const statusColor: Record<string, string> = {
		open: 'bg-bg-muted text-text-muted',
		in_progress: 'bg-warning/15 text-warning',
		completed: 'bg-success/15 text-success',
		done: 'bg-success/15 text-success',
		failed: 'bg-danger/15 text-danger',
	};

	$effect(() => { loadTasks(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<a href="/app/settings" class="text-xs text-text-subtle hover:text-text transition-colors">&larr; {t('settings.back')}</a>
	<div class="flex items-center justify-between mb-4 mt-2">
		<h1 class="text-xl font-light tracking-tight">{t('tasks.title')}</h1>
		<button onclick={createInChat} class="rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1.5 text-sm text-accent-text hover:bg-accent/15">+ {t('tasks.create_in_chat')}</button>
	</div>

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
							<button onclick={() => manageInChat(task)} aria-label={t('tasks.manage_in_chat')} title={t('tasks.manage_in_chat')} class="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-[10px] text-text-muted hover:text-text transition-opacity"><Icon name="chat" size="xs" /></button>
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
</div>
