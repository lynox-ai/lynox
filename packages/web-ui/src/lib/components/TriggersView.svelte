<script lang="ts">
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { sanitizeFramingField } from '../utils/chat-framing.js';
	import { awaitsConfirmation, confirmationOutcome, displaySafe, instructionOf, watchOf } from '../utils/trigger-consent.js';

	// An agent-trigger (cron/watch/pipeline/reminder/backup) — the `triggers`
	// table split out of `tasks` in v42. This is the editable *home* for them:
	// glanceable status + the controls a trigger needs (confirm/pause/run-now/
	// delete), while creating + editing schedule/params happens by talking to the
	// agent (the chat is the editor — it can express a schedule a form never could).
	interface Trigger {
		id: string;
		title: string;
		// What an agent run is told to do, beside the title. Shown while the
		// trigger waits for confirmation, because that is what is being confirmed.
		description?: string;
		status: string;
		schedule_cron?: string;
		next_run_at?: string;
		last_run_at?: string;
		last_run_status?: string;
		source?: string;
		effect?: string;
		watch_config?: string;
		pipeline_id?: string;
		// SQLite kill-switch: 1/undefined = enabled, 0 = paused (schedule skipped).
		enabled?: number;
		// Set when a person confirmed the trigger; absent = not confirmed. An agent
		// run without it is skipped by the scheduler — see `awaitsConfirmation`.
		confirmed_at?: string;
	}

	let triggers = $state<Trigger[]>([]);
	let loading = $state(true);
	let error = $state('');
	// Per-trigger in-flight guard so a double-click can't fire two run-now /
	// pause requests for the same row.
	let busy = $state<Record<string, boolean>>({});

	async function loadTriggers() {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/triggers`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { triggers: Trigger[] };
			triggers = data.triggers;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
	}

	// Triggers are created + edited by talking to the agent (the chat can
	// express cron, watch URLs, workflow params — a form can't). "New trigger"
	// opens a fresh chat to create one; per-row "Manage in chat" seeds it with
	// the trigger id so the agent can reschedule / re-target / edit it. The
	// title is user/agent-authored, so it passes through the sanitiser first.
	function createInChat(): void {
		newChat();
		void sendMessage(t('triggers.create_in_chat_prompt'));
		void goto('/app');
	}

	function manageInChat(trigger: Trigger): void {
		newChat();
		const title = sanitizeFramingField(trigger.title);
		const id = sanitizeFramingField(trigger.id, 80);
		void sendMessage(`${t('triggers.manage_in_chat_prompt')} "${title}" (id: ${id}).`);
		void goto('/app');
	}

	// Pause/resume = the cron kill-switch. Goes through the unified
	// `PATCH /api/tasks/:id {enabled}` route, which resolves the row's kind by
	// id and toggles the `triggers` table (the schedule stops/starts firing;
	// the trigger itself is kept).
	async function togglePause(trigger: Trigger): Promise<void> {
		if (busy[trigger.id]) return;
		busy[trigger.id] = true;
		const nextEnabled = trigger.enabled === 0 ? true : false;
		try {
			const res = await fetch(`${getApiBase()}/tasks/${trigger.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: nextEnabled }),
			});
			if (!res.ok) throw new Error();
			await loadTriggers();
		} catch {
			addToast(t('common.save_failed'), 'error');
		} finally {
			busy[trigger.id] = false;
		}
	}

	// Confirm = a person allows this trigger to run unattended. Stamps
	// `confirmed_at` through `POST /api/tasks/:id/confirm`; the trigger keeps its
	// schedule and becomes due in place — nothing else about it changes.
	//
	// The message says only what confirming did. It used to add "runs on its
	// schedule", which is false for every row the scheduler holds back for a
	// second reason — a paused one above all, and Pause sits on this same card.
	async function confirmTrigger(trigger: Trigger): Promise<void> {
		if (busy[trigger.id]) return;
		busy[trigger.id] = true;
		try {
			const res = await fetch(`${getApiBase()}/tasks/${trigger.id}/confirm`, { method: 'POST' });
			if (!res.ok) throw new Error();
			// The route answers with the stored row, so the message speaks from what
			// the engine has, not from what this list happened to load: another
			// window may have paused the trigger since.
			const stored = (await res.json().catch(() => null)) as Trigger | null;
			const paused = (stored ?? trigger).enabled === 0;
			addToast(paused ? t('triggers.confirmed_paused') : t('triggers.confirmed'), 'success');
			await loadTriggers();
		} catch {
			addToast(t('triggers.confirm_failed'), 'error');
		} finally {
			busy[trigger.id] = false;
		}
	}

	// Run now = dispatch this trigger off-schedule. The engine runs it through
	// the same execute path (and consent gate) as a scheduled fire; 202 =
	// started (result lands in the run history), 409 = already running.
	async function runNow(trigger: Trigger): Promise<void> {
		if (busy[trigger.id]) return;
		busy[trigger.id] = true;
		try {
			const res = await fetch(`${getApiBase()}/triggers/${trigger.id}/run`, { method: 'POST' });
			if (res.status === 202) {
				addToast(t('triggers.run_started'), 'success');
			} else if (res.status === 409) {
				addToast(t('triggers.run_already'), 'info');
			} else {
				addToast(t('triggers.run_failed'), 'error');
			}
		} catch {
			addToast(t('triggers.run_failed'), 'error');
		} finally {
			busy[trigger.id] = false;
		}
	}

	async function deleteTrigger(trigger: Trigger): Promise<void> {
		if (busy[trigger.id]) return;
		if (!window.confirm(t('triggers.delete_confirm'))) return;
		busy[trigger.id] = true;
		try {
			const res = await fetch(`${getApiBase()}/tasks/${trigger.id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error();
			await loadTriggers();
		} catch {
			addToast(t('common.save_failed'), 'error');
		} finally {
			busy[trigger.id] = false;
		}
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

	function typeLabel(trigger: Trigger): string {
		// Label from the clean effect·source axes (S3-behaviour-a). effect='run_workflow'
		// covers an FK-nulled workflow trigger too (pipeline_id undefined but effect kept),
		// which the old pipeline_id check mislabeled.
		switch (trigger.effect) {
			case 'run_workflow': return t('triggers.type_workflow');
			case 'backup': return t('triggers.type_backup');
			case 'notify': return t('triggers.type_reminder');
			case 'run_agent': return trigger.source === 'watch' ? t('triggers.type_watch') : t('triggers.type_scheduled');
			default: return t('triggers.type_scheduled');
		}
	}

	function fmtDate(iso: string): string {
		return new Date(iso).toLocaleString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
	}

	const runStatusColor: Record<string, string> = {
		success: 'text-success',
		failed: 'text-danger',
		timeout: 'text-danger',
	};

	$effect(() => { loadTriggers(); });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<div class="flex items-center justify-between mb-1">
		<h1 class="text-xl font-light tracking-tight">{t('triggers.title')}</h1>
		<button onclick={createInChat} class="rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1.5 text-sm text-accent-text hover:bg-accent/15">+ {t('triggers.create_in_chat')}</button>
	</div>
	<p class="text-xs text-text-subtle mb-4">{t('triggers.subtitle')}</p>

	{#if error}
		<div class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4">{error}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm mb-4">{t('common.loading')}</p>
	{:else if triggers.length > 0}
		<div class="space-y-2 mb-6">
			{#each triggers as trigger}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3 group {trigger.enabled === 0 ? 'opacity-60' : ''}">
					<!-- Stacked below `sm`: the controls are a fixed ~290px and the card is ~310px
					     wide on a phone, so side by side left the text column a few pixels and the
					     title — `line-clamp`, so `overflow: hidden` — collapsed to nothing. That
					     predates the confirmation block, and the block needs the room most: what is
					     being confirmed has to be readable. -->
					<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
						<div class="flex-1 min-w-0">
							<!-- Wrapping, so the badges move to their own line on a narrow card instead
							     of squeezing the title: the badges are `shrink-0` and the title clamps. -->
							<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
								<p class="text-sm font-medium line-clamp-2 break-words">{trigger.title}</p>
								<span class="shrink-0 text-[10px] rounded-[var(--radius-sm)] bg-bg-muted px-1.5 py-0.5 text-text-muted">{typeLabel(trigger)}</span>
								{#if trigger.enabled === 0}
									<span class="shrink-0 text-[10px] rounded-[var(--radius-sm)] bg-warning/15 px-1.5 py-0.5 text-warning">{t('triggers.paused')}</span>
								{/if}
								{#if awaitsConfirmation(trigger)}
									<span class="shrink-0 text-[10px] rounded-[var(--radius-sm)] bg-warning/15 px-1.5 py-0.5 text-warning">{t('triggers.awaiting_confirmation')}</span>
								{/if}
							</div>
							<div class="flex flex-wrap gap-2 mt-1.5 text-xs text-text-subtle">
								{#if trigger.schedule_cron}
									<span class="flex items-center gap-1">
										<Icon name="clock" size="xs" />
										{cronToHuman(trigger.schedule_cron)}
									</span>
								{/if}
								<!-- A waiting trigger keeps its next_run_at, and that date is usually in the
								     past — it is not a next run, so it is not labelled as one. It is said
								     in the consent block below instead, where it is the thing a person
								     needs: what confirming starts, and when. -->
								{#if trigger.next_run_at && trigger.enabled !== 0 && !awaitsConfirmation(trigger)}
									<span>{t('tasks.next_run')}: {fmtDate(trigger.next_run_at)}</span>
								{/if}
								{#if trigger.last_run_at}
									<span class={runStatusColor[trigger.last_run_status ?? ''] ?? ''}>{t('tasks.last_run')}: {fmtDate(trigger.last_run_at)}</span>
								{/if}
							</div>
							{#if awaitsConfirmation(trigger)}
								<!-- Confirming allows this to run without the owner present, so the block says
								     what would run and what would follow. A watch runs on a PAGE — `executeWatch`
								     prompts with the fetched page and the description reaches it nowhere — so it is
								     shown that address and its cadence instead of an instruction it does not get. `displaySafe` removes what
								     could forge that text — it is written by the agent and can quote what the
								     agent read elsewhere. -->
								<div class="mt-2 space-y-1.5" data-trigger-consent>
									<p class="text-xs text-warning">{t('triggers.awaiting_hint')}</p>
									{#if watchOf(trigger)}
										<div class="text-xs text-text-muted" data-consent-watch>
											<p class="break-words"><span class="font-medium">{t('triggers.watch_url')}:</span> {displaySafe(watchOf(trigger)?.url ?? '')}</p>
											{#if watchOf(trigger)?.intervalMinutes}
												<p class="mt-0.5">{tf('triggers.watch_every', { minutes: String(watchOf(trigger)?.intervalMinutes) })}</p>
											{/if}
										</div>
									{:else}
										<div class="text-xs text-text-muted" data-consent-instruction>
											<span class="font-medium">{t('triggers.instruction')}:</span>
											<p class="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">{displaySafe(instructionOf(trigger))}</p>
										</div>
									{/if}
									{#if confirmationOutcome(trigger) === 'paused'}
										<p class="text-xs text-text-muted">{t('triggers.awaiting_paused')}</p>
									{:else if confirmationOutcome(trigger) === 'due-now'}
										<p class="text-xs text-text-muted">{tf('triggers.awaiting_due_since', { date: fmtDate(trigger.next_run_at ?? '') })}</p>
									{:else if confirmationOutcome(trigger) === 'scheduled'}
										<p class="text-xs text-text-muted">{tf('triggers.awaiting_first_run', { date: fmtDate(trigger.next_run_at ?? '') })}</p>
									{:else}
										<p class="text-xs text-text-muted">{t('triggers.awaiting_not_scheduled')}</p>
									{/if}
									<button onclick={() => confirmTrigger(trigger)} disabled={busy[trigger.id]} aria-label={t('triggers.confirm_label')} title={t('triggers.confirm_label')} class="rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/15 disabled:opacity-40">{t('triggers.confirm')}</button>
								</div>
							{/if}
						</div>
						<!-- The controls hide until hover where hovering exists, and stay visible
						     where it does not — keyed on the POINTER, not on a width: a touch screen
						     wider than `sm` has no hover either, and there they only appeared when a
						     tap happened to leave the card in `:hover`. -->
						<div class="flex flex-wrap items-center gap-2 sm:shrink-0 sm:mt-0.5">
							<!-- Not offered while waiting: the engine refuses the run after the request
							     has already been answered as started. -->
							{#if !awaitsConfirmation(trigger)}
								<button onclick={() => runNow(trigger)} disabled={busy[trigger.id]} aria-label={t('triggers.run_now')} title={t('triggers.run_now')} class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent-text hover:bg-accent/20 transition-opacity disabled:opacity-40">▶ {t('triggers.run_now')}</button>
							{/if}
							<button onclick={() => togglePause(trigger)} disabled={busy[trigger.id]} class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-[10px] text-text-muted hover:text-text transition-opacity disabled:opacity-40">{trigger.enabled === 0 ? t('triggers.resume') : t('triggers.pause')}</button>
							<button onclick={() => manageInChat(trigger)} aria-label={t('triggers.manage_in_chat')} title={t('triggers.manage_in_chat')} class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-[10px] text-text-muted hover:text-text transition-opacity"><Icon name="chat" size="xs" /></button>
							<button onclick={() => deleteTrigger(trigger)} disabled={busy[trigger.id]} class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/20 transition-opacity disabled:opacity-40">{t('triggers.delete')}</button>
						</div>
					</div>
				</div>
			{/each}
		</div>
	{:else}
		<div class="text-center py-12 text-text-subtle">
			<p class="text-sm">{t('triggers.no_triggers')}</p>
			<p class="text-xs mt-2">{t('triggers.no_triggers_hint')}</p>
		</div>
	{/if}
</div>
