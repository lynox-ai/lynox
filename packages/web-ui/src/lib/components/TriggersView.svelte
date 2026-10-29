<script lang="ts">
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { t, tf, getLocale } from '../i18n.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { sanitizeFramingField } from '../utils/chat-framing.js';
	import { escalationNotice } from '../utils/trigger-escalation.js';
	import { awaitsConfirmation, displaySafe, instructionOf, showsInstruction, showsWatchTarget, watchOf } from '../utils/trigger-consent.js';
	import { endedNotices, refusalText, takeoverLines, type PausedEnded, type TakeoverPreview } from '../utils/plan-takeover.js';
	import { refreshPausedPlans } from '../stores/paused-plans.svelte.js';
	import { awaitsOwnerStamp, listedLine, listedNote, stampable, usesConnections, type StampListed } from '../utils/stamp-confirm.js';
	import StampConfirm from './StampConfirm.svelte';

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
		// Who set the trigger up and who last changed it (tags: `owner`, `mandate:<address>`). A
		// schedule a mandate set up or last changed waits for the owner's stamp (`awaitsOwnerStamp`).
		created_by?: string;
		edited_by?: string;
		// What the owner's stamp of a confirmed plan lists, entry by entry (owner only; B3).
		stamp_listed?: StampListed | null;
		// Whether the last escalation of this trigger (a failed scheduled run, a watch
		// finding) reached anyone — see `escalationNotice`.
		last_escalation_at?: string;
		last_escalation_outcome?: string;
		// Whether a run of this trigger is in flight right now, and whether a stop can end it
		// (`GET /api/triggers`; a mandate is told only about its own runs). Snapshots from
		// the last load: the stop route still answers a run that ended since.
		running?: boolean;
		stoppable?: boolean;
		// Paused because the access of someone who set up or changed it ended: it does not run
		// until it is taken over (`GET /api/triggers`, engine `plan-pause.ts`).
		paused?: boolean;
		// Whose ended access paused it, for the owner only (a helper is not told about another's).
		paused_who?: string[];
		// How and when each of those accesses ended, for the owner only: the notices above the list.
		paused_ended?: PausedEnded[];
	}

	// How often the list is reloaded while the tab is visible, so a run that started on its
	// own shows as running and offers its stop.
	const LIVE_REFRESH_MS = 15_000;

	let triggers = $state<Trigger[]>([]);
	// Who reads the list (`GET /api/triggers`). Only the owner takes a plan over; the route says
	// so too (ownerOnly), the button only follows it.
	let viewer = $state<'owner' | 'mandate' | 'none'>('none');
	let loading = $state(true);
	let error = $state('');
	// Per-trigger in-flight guard so a double-click can't fire two run-now /
	// pause requests for the same row.
	let busy = $state<Record<string, boolean>>({});

	// `quiet`: refresh in place after a stop or a start, without swapping the list for the
	// loading line — that would drop keyboard focus from the row the owner just acted on.
	//
	// Loads overlap since the list refreshes on its own. An answer is dropped only when a NEWER
	// answer is already shown — otherwise a refresh that started before a delete or a stop lands
	// after the action's own reload and brings the old row back. Being overtaken by a newer load
	// that then FAILED is no reason to drop it: that would leave the first load's list unshown and
	// the view saying there are no triggers. A quiet load that fails leaves the list and says
	// nothing — the owner did nothing, and the next refresh tries again. A loud load that fails
	// (the first one, and the reload after a pause, a confirm or a delete) does show its error,
	// also above a list an earlier load put on screen, as it did before; the next success clears it.
	let nextLoad = 0;
	let shownLoad = 0;
	async function loadTriggers(quiet = false) {
		const load = ++nextLoad;
		if (!quiet) { loading = true; error = ''; }
		try {
			const res = await fetch(`${getApiBase()}/triggers`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { triggers: Trigger[]; viewer?: 'owner' | 'mandate' | 'none' };
			if (load < shownLoad) return;
			shownLoad = load;
			triggers = data.triggers;
			viewer = data.viewer ?? 'none';
			error = '';
			loading = false;
		} catch {
			if (quiet) return;
			if (load > shownLoad) error = t('common.load_failed');
			loading = false;
		}
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

	// Confirm = the owner allows this trigger to run unattended. `StampConfirm` shows the schedule
	// from the stamp preview and confirms with its `expect` (641 4b (ii-a)): the owner stamps what
	// they read, and the connections listed beside it. The message says what confirming did and
	// nothing about when the run comes — that is the scheduler's answer, on its own surface.
	//
	// Waiting for a stamp: an unconfirmed agent run, or anything a mandate set up or last changed.
	function held(trigger: Trigger): boolean {
		return awaitsConfirmation(trigger) || awaitsOwnerStamp(trigger);
	}
	// The stamp is the owner's (the route is ownerOnly); a helper sees what waits, not a button.
	function ownerStamps(trigger: Trigger): boolean {
		return viewer === 'owner' && stampable(trigger);
	}
	// "Check connections": a confirmed schedule whose run can use a connection, opened on demand,
	// so the preview is not asked for on every refresh (ux U-058, ii-c-min).
	let checking = $state<Record<string, boolean>>({});
	function offersCheck(trigger: Trigger): boolean {
		return ownerStamps(trigger) && !held(trigger) && !!trigger.confirmed_at && usesConnections(trigger);
	}
	async function stamped(trigger: Trigger): Promise<void> {
		checking[trigger.id] = false;
		await loadTriggers(true);
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
				// The run is registered before the 202 is sent, so a reload shows it running —
				// and offers its stop, which is when an owner most wants one.
				await loadTriggers(true);
			} else if (res.status === 409) {
				// ⛔ TWO different 409s, and telling the owner the wrong one is what this
				// branch is for. "Already running" is true for a run in flight; a trigger
				// PARKED on a question is also refused, and there the owner's next move is
				// to answer it — a sentence they never saw while this branch showed one
				// fixed string and never read the body.
				const code = await res.json().then((b: { code?: string }) => b.code).catch(() => undefined);
				const who = trigger.paused_who?.join(', ') ?? '';
				addToast(code === 'awaiting_answer' ? t('triggers.run_awaiting_answer')
					: code === 'paused' ? (who !== '' ? tf('triggers.run_paused', { who }) : t('triggers.run_paused_anon'))
					: t('triggers.run_already'), 'info');
				// "Already running" — so show it running, and offer its stop.
				await loadTriggers(true);
			} else {
				addToast(t('triggers.run_failed'), 'error');
			}
		} catch {
			addToast(t('triggers.run_failed'), 'error');
		} finally {
			busy[trigger.id] = false;
		}
	}

	// Stop = end the run in flight (`POST /api/tasks/:id/stop`). Offered only on a row the
	// list reported as stoppable. 202 = the stop was REQUESTED, not completed — the run can
	// still finish on its own, and the toast says so. Every refusal gets its own
	// sentence, told apart by the route's `code`: a run that ended since the list loaded,
	// a phase nothing can interrupt (pausing is what is left), an id that names more than
	// one task, and a 403 for someone who neither owns the instance nor started the run.
	async function stopRun(trigger: Trigger): Promise<void> {
		if (busy[trigger.id]) return;
		busy[trigger.id] = true;
		try {
			const res = await fetch(`${getApiBase()}/tasks/${trigger.id}/stop`, { method: 'POST' });
			if (res.status === 202) {
				addToast(t('triggers.stop_requested'), 'success');
			} else if (res.status === 403) {
				addToast(t('triggers.stop_forbidden'), 'error');
			} else if (res.status === 409) {
				const code = await res.json().then((b: { code?: string }) => b.code).catch(() => undefined);
				addToast(t(code === 'unstoppable' ? 'triggers.stop_unstoppable'
					: code === 'ambiguous_id' ? 'triggers.stop_ambiguous'
					: code === 'not_running' ? 'triggers.stop_not_running'
					: 'triggers.stop_failed'), code === 'not_running' ? 'info' : 'error');
			} else {
				addToast(t('triggers.stop_failed'), 'error');
			}
			await loadTriggers(true);
		} catch {
			addToast(t('triggers.stop_failed'), 'error');
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

	// Take over = the owner's consent to what the preview shows (`plan-takeover.ts`): who the plan
	// then runs for, what else changes. The POST carries the preview's digest, so a plan that
	// changed in between is refused (`changed`) and shown again rather than taken over unseen.
	// Not at a bulk run: no helper set one up (U-039). The route answers the same.
	function offersTakeover(trigger: Trigger): boolean {
		return viewer === 'owner' && pausedOpen(trigger) && !(trigger.effect ?? '').startsWith('bulk_');
	}

	// A completed plan keeps its pause (reopened, it would need the takeover still), but nothing is
	// due on it: no label, no button, not in the notices, as the badge's count leaves it out too.
	function pausedOpen(trigger: Trigger): boolean {
		return trigger.paused === true && trigger.status !== 'completed';
	}

	let takeoverFor = $state<Trigger | null>(null);
	let takeoverPreview = $state<TakeoverPreview | null>(null);
	// A line above the preview: why it was fetched again, or why the takeover was refused.
	let takeoverNote = $state('');
	let takeoverBusy = $state(false);
	// The preview could not be loaded: the dialog offers to load it again (ux, as U-011).
	let previewFailed = $state(false);
	let takeoverCancel = $state<HTMLButtonElement | null>(null);
	let takeoverDialog = $state<HTMLElement | null>(null);

	// Escape is the dialog's when focus is in it, or nowhere (after a re-fetch took the focused
	// button). Focus in an overlay above it, such as the command palette, is that overlay's Escape.
	function escapeIsOurs(): boolean {
		const at = document.activeElement;
		return at === null || at === document.body || (takeoverDialog?.contains(at) ?? false);
	}

	// Whether lynox hosts this instance, for the support line under a lasting failure. Asked only
	// when one happens; unknown reads as not hosted, so no address is offered that may not help.
	async function isHosted(): Promise<boolean> {
		try {
			const res = await fetch(`${getApiBase()}/secrets/status`);
			if (!res.ok) return false;
			const data = (await res.json()) as { managed?: string | null };
			return typeof data.managed === 'string' && data.managed !== '';
		} catch {
			return false;
		}
	}

	function dayOf(iso: string): string {
		return new Date(iso).toLocaleDateString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
	}

	// The day an access ended, in UTC: the push names it so (`plan-pause.ts` `dateOf`), and the
	// notice the push leads to must name the same day.
	function endDayOf(iso: string): string {
		return new Date(iso).toLocaleDateString(getLocale() === 'de' ? 'de-CH' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
	}

	// Each preview request is numbered: an answer for a dialog closed or opened on another plan
	// since is dropped, so no plan's lines stand under another plan's title.
	let previewRequest = 0;
	const currentPreview = (n: number, trigger: Trigger): boolean => n === previewRequest && takeoverFor?.id === trigger.id;

	async function fetchPreview(trigger: Trigger): Promise<void> {
		const n = ++previewRequest;
		takeoverPreview = null;
		previewFailed = false;
		try {
			const res = await fetch(`${getApiBase()}/triggers/${trigger.id}/takeover-preview`);
			if (!currentPreview(n, trigger)) return;
			if (!res.ok) throw new Error();
			const data = (await res.json()) as TakeoverPreview & { refusal: string | null; message?: string };
			if (!currentPreview(n, trigger)) return;
			if (data.refusal !== null) {
				takeoverNote = refusalText(data.refusal, { workflow: null, managed: false, fallback: data.message ?? t('takeover.load_failed') });
				if (data.refusal === 'nothing_to_take_over') void loadTriggers(true);
				return;
			}
			takeoverPreview = data;
		} catch {
			if (!currentPreview(n, trigger)) return;
			takeoverNote = t('takeover.load_failed');
			previewFailed = true;
		}
	}

	async function reloadPreview(): Promise<void> {
		if (takeoverFor === null) return;
		takeoverNote = '';
		await fetchPreview(takeoverFor);
	}

	// Where focus goes back to when the dialog closes: the row's button that opened it.
	let takeoverOpener: HTMLElement | null = null;

	async function openTakeover(trigger: Trigger): Promise<void> {
		takeoverOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		takeoverFor = trigger;
		takeoverNote = '';
		takeoverBusy = false;
		await fetchPreview(trigger);
	}

	function closeTakeover(): void {
		previewRequest++;
		takeoverFor = null;
		takeoverPreview = null;
		takeoverNote = '';
		const opener = takeoverOpener;
		takeoverOpener = null;
		if (opener?.isConnected === true) opener.focus();
	}

	// Focus on "Cancel" when the dialog opens: a confirmation that consents to something must not
	// be one Enter away from it.
	$effect(() => {
		if (takeoverFor !== null && takeoverCancel !== null) takeoverCancel.focus();
	});

	async function confirmTakeover(): Promise<void> {
		const trigger = takeoverFor;
		const preview = takeoverPreview;
		if (trigger === null || preview === null || takeoverBusy) return;
		// The dialog this takeover was confirmed in: an answer that comes after it was closed (or
		// another plan's opened) only reloads the list, and says nothing in a dialog it was not for.
		const n = previewRequest;
		takeoverBusy = true;
		try {
			const res = await fetch(`${getApiBase()}/triggers/${trigger.id}/takeover`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ expect: preview.expect }),
			});
			const body = res.ok ? {} : await res.json().then((b: { code?: string; error?: string }) => b).catch(() => ({} as { code?: string; error?: string }));
			const managed = res.status === 503 ? await isHosted() : false;
			// One check, after the last await of the answer: a dialog closed or opened for another plan
			// since is not this answer's.
			if (!currentPreview(n, trigger)) {
				if (res.ok) { addToast(t('takeover.done'), 'success'); refreshPausedPlans(); }
				await loadTriggers(true);
				return;
			}
			if (res.ok) {
				addToast(t('takeover.done'), 'success');
				closeTakeover();
				refreshPausedPlans();
				await loadTriggers(true);
				return;
			}
			const code = body.code ?? '';
			const text = refusalText(code, { workflow: preview.workflow?.name ?? null, managed, fallback: body.error ?? t('takeover.load_failed') });
			if (code === 'changed') {
				// What changed is shown, with the line above it; the owner decides again. The re-fetch
				// is the dialog's request now; closed or replaced meanwhile, nothing is written.
				const refetch = fetchPreview(trigger);
				const m = previewRequest;
				await refetch;
				if (!currentPreview(m, trigger)) return;
				takeoverNote = text;
				// The button that had focus left with the old preview; focus goes back to Cancel.
				takeoverCancel?.focus();
			} else if (code === 'nothing_to_take_over') {
				addToast(text, 'info');
				closeTakeover();
				await loadTriggers(true);
			} else {
				takeoverNote = text;
			}
		} catch {
			if (currentPreview(n, trigger)) takeoverNote = t('takeover.load_failed');
		} finally {
			// The dialog's own flag: a dialog opened since for another plan has its own (`openTakeover`).
			if (takeoverFor === null || takeoverFor.id === trigger.id) takeoverBusy = false;
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

	// A missing key renders with NO class, which reads as "no verdict" rather than as
	// the verdict it is — so a word added to the engine's vocabulary has to be added
	// here in the same change. `stopped` is not a failure: someone ended the run on
	// purpose (its owner, or the chat or mandate it depended on ended), so it gets the
	// muted colour rather than the danger one.
	const runStatusColor: Record<string, string> = {
		success: 'text-success',
		failed: 'text-danger',
		timeout: 'text-danger',
		// ⚠ `text-text-muted`, not `text-muted`: the theme token is `--color-text-muted`
		// (app.css), while success and danger are `--color-success`/`--color-danger`. A
		// utility for a token that does not exist compiles and renders NOTHING — the
		// same silent no-verdict this entry exists to remove.
		stopped: 'text-text-muted',
		// The run stopped where its approval told it to (a bulk run at its approved maximum)
		// and waits for the owner: not a failure, so not red.
		halted: 'text-text-muted',
		// The engine lost the run and did not start it again. It did not finish, which the
		// owner should see, but it is not the run's own failure: amber, not red.
		interrupted: 'text-warning',
	};
	// Colour alone does not tell these apart from the rest (and not at all to a reader
	// who does not see colour), so they also carry a word. `stopped` and `halted` share
	// the muted colour, which makes the word the only thing that separates them.
	const runStatusWord: Record<string, 'tasks.run_halted' | 'tasks.run_interrupted' | 'tasks.run_stopped'> = {
		halted: 'tasks.run_halted',
		interrupted: 'tasks.run_interrupted',
		stopped: 'tasks.run_stopped',
	};

	$effect(() => { void loadTriggers(); /* catches and sets its error */ });

	// `running` and `stoppable` are snapshots, and a scheduled run starts on its own: without
	// a refresh, the Stop button of a run that began while the page was open never appears.
	// Only while the tab is visible — a hidden tab has nobody to show the button to.
	$effect(() => {
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void loadTriggers(true);
		}, LIVE_REFRESH_MS);
		return () => clearInterval(timer);
	});
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

	<!-- Where a tap on the pause push lands: each ended access in full, address and all (the push
	     shortens the name to fit). The owner's only — a helper's list carries no `paused_ended`. -->
	{#if viewer === 'owner'}
		{#each endedNotices(triggers.filter(pausedOpen), endDayOf) as notice}
			<div class="rounded-[var(--radius-md)] bg-warning/10 border border-warning/20 px-4 py-3 text-sm text-text mb-4 break-words" data-paused-notice>{notice}</div>
		{/each}
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm mb-4">{t('common.loading')}</p>
	{:else if triggers.length > 0}
		<div class="space-y-2 mb-6">
			{#each triggers as trigger (trigger.id)}
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
								{#if held(trigger)}
									<span class="shrink-0 text-[10px] rounded-[var(--radius-sm)] bg-warning/15 px-1.5 py-0.5 text-warning" data-trigger-held>{t('triggers.awaiting_confirmation')}</span>
								{/if}
								{#if trigger.running === true}
									<span class="shrink-0 text-[10px] rounded-[var(--radius-sm)] bg-accent/10 px-1.5 py-0.5 text-accent-text" data-trigger-running>{t('triggers.running')}</span>
								{/if}
								{#if pausedOpen(trigger)}
									<span class="shrink-0 text-[10px] rounded-[var(--radius-sm)] bg-warning/15 px-1.5 py-0.5 text-warning" data-trigger-paused>{t('triggers.paused_takeover')}</span>
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
								{#if trigger.next_run_at && trigger.enabled !== 0 && !held(trigger) && trigger.paused !== true}
									<span>{t('tasks.next_run')}: {fmtDate(trigger.next_run_at)}</span>
								{/if}
								{#if trigger.last_run_at}
									<span class={runStatusColor[trigger.last_run_status ?? ''] ?? ''} data-run-status={trigger.last_run_status}>{t('tasks.last_run')}: {fmtDate(trigger.last_run_at)}{#if Object.hasOwn(runStatusWord, trigger.last_run_status ?? '')}&nbsp;· {t(runStatusWord[trigger.last_run_status ?? '']!)}{/if}</span>
								{/if}
								{#if escalationNotice(trigger)}
									{@const notice = escalationNotice(trigger)!}
									<span class={notice.warn ? 'text-warning' : ''} data-escalation-notice={trigger.last_escalation_outcome}>{t(notice.key)} · {fmtDate(notice.at)}</span>
								{/if}
							</div>
							{#if held(trigger)}
								<!-- Confirming allows this to run without the owner present, so what the run
								     would carry out is shown beside the button — a button next to nothing but an
								     agent-written heading is a rubber stamp. `displaySafe` removes what could
								     forge that text; it is written by the agent and can quote what the agent read
								     elsewhere. A watch runs on a PAGE and never receives that text, so it is asked
								     about its address and cadence instead (`showsWatchTarget`) — and if the stored
								     address cannot be read, it is asked nothing at all, because there would be
								     nothing to agree to. One gate for the button (`offersConfirmation`), so it can
								     never outlive the thing it consents to. -->
								<div class="mt-2 space-y-1.5" data-trigger-consent>
									<p class="text-xs text-warning">{t('triggers.awaiting_hint')}</p>
									{#if ownerStamps(trigger)}
										<!-- The owner's block reads the schedule from the stamp preview, so what
										     is shown is what the stamp holds (`StampConfirm`). -->
										<StampConfirm id={trigger.id} mode="held" cronText={cronToHuman} onstamped={() => void stamped(trigger)} />
									{:else if showsInstruction(trigger)}
										<div class="text-xs text-text-muted" data-consent-instruction>
											<span class="font-medium" data-consent-label="instruction">{t('triggers.instruction')}:</span>
											<p class="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">{displaySafe(instructionOf(trigger))}</p>
										</div>
									{/if}
									{#if !ownerStamps(trigger) && showsWatchTarget(trigger)}
										<div class="text-xs text-text-muted" data-consent-watch>
											<span class="font-medium" data-consent-label="watch">{t('triggers.watch_url')}:</span>
											<p class="mt-0.5 break-words rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5"><span class="font-medium text-text">{watchOf(trigger)?.host ?? ''}</span>{watchOf(trigger)?.rest ?? ''}</p>
											{#if watchOf(trigger)?.intervalMinutes}
												<p class="mt-0.5" data-consent-cadence>{tf('triggers.watch_every', { minutes: String(watchOf(trigger)?.intervalMinutes) })}</p>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
							{#if viewer === 'owner' && !held(trigger) && trigger.stamp_listed}
								{@const listed = trigger.stamp_listed}
								<div class="mt-2 text-xs text-text-muted" data-stamp-listed>
									<span class="font-medium">{t('stamp.listed_heading')}:</span>
									<ul class="mt-0.5">
										{#each listed.entries as entry}
											<li data-stamp-entry={entry.state}>{listedLine(entry)}</li>
										{/each}
									</ul>
									{#if listedNote(listed, trigger.paused === true)}
										<p class="mt-0.5 text-warning" data-stamp-note>{listedNote(listed, trigger.paused === true)}</p>
									{/if}
								</div>
							{/if}
							{#if checking[trigger.id] && offersCheck(trigger)}
								<StampConfirm id={trigger.id} mode="check" cronText={cronToHuman} onstamped={() => void stamped(trigger)} onclose={() => (checking[trigger.id] = false)} />
							{/if}
						</div>
						<!-- The controls hide until hover where hovering exists, and stay visible
						     where it does not — keyed on the POINTER, not on a width: a touch screen
						     wider than `sm` has no hover either, and there they only appeared when a
						     tap happened to leave the card in `:hover`. -->
						<div class="flex flex-wrap items-center gap-2 sm:shrink-0 sm:mt-0.5">
							<!-- Stop: only where a stop can end the run. Not hidden until hover like the
							     others — a run the owner wants to end should not need finding. -->
							{#if trigger.stoppable === true}
								<button onclick={() => stopRun(trigger)} disabled={busy[trigger.id]} aria-label={t('triggers.stop_run')} title={t('triggers.stop_run')} class="rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/20 disabled:opacity-40" data-trigger-stop>■ {t('triggers.stop_run')}</button>
							{/if}
							<!-- Not offered while waiting: the engine refuses the run after the request
							     has already been answered as started. -->
							{#if !held(trigger)}
								<button onclick={() => runNow(trigger)} disabled={busy[trigger.id]} aria-label={t('triggers.run_now')} title={t('triggers.run_now')} class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent-text hover:bg-accent/20 transition-opacity disabled:opacity-40">▶ {t('triggers.run_now')}</button>
							{/if}
							<button onclick={() => togglePause(trigger)} disabled={busy[trigger.id]} class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-[10px] text-text-muted hover:text-text transition-opacity disabled:opacity-40">{trigger.enabled === 0 ? t('triggers.resume') : t('triggers.pause')}</button>
							<button onclick={() => manageInChat(trigger)} aria-label={t('triggers.manage_in_chat')} title={t('triggers.manage_in_chat')} class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-[10px] text-text-muted hover:text-text transition-opacity"><Icon name="chat" size="xs" /></button>
							<button onclick={() => deleteTrigger(trigger)} disabled={busy[trigger.id]} class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 px-2 py-0.5 text-[10px] text-danger hover:bg-danger/20 transition-opacity disabled:opacity-40">{t('triggers.delete')}</button>
							{#if offersCheck(trigger)}
								<button onclick={() => (checking[trigger.id] = !checking[trigger.id])} aria-expanded={checking[trigger.id] === true} class="[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-0.5 text-[10px] text-text-muted hover:text-text transition-opacity" data-trigger-check>{t('stamp.check')}</button>
							{/if}
							<!-- Take over: always visible, like Stop — a paused plan does nothing until it is.
							     Last, so it ends the row where the hidden controls hold their place (ux). -->
							{#if offersTakeover(trigger)}
								<button onclick={() => openTakeover(trigger)} disabled={busy[trigger.id]} class="rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent-text hover:bg-accent/20 disabled:opacity-40" data-trigger-takeover>{t('takeover.button')}</button>
							{/if}
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

<!-- Escape closes the dialog while focus is in it or nowhere (a re-fetch can take the focused
     button); focus in an overlay above it, such as the command palette, keeps Escape for that. -->
<svelte:window onkeydown={(e) => { if (takeoverFor !== null && e.key === 'Escape' && escapeIsOurs()) closeTakeover(); }} />
{#if takeoverFor !== null}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="takeover-title"
		tabindex="-1"
		bind:this={takeoverDialog}
		data-takeover-dialog
	>
		<div class="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-[var(--radius-md)] border border-border bg-bg p-5 shadow-lg">
			<h2 id="takeover-title" class="text-sm font-medium mb-1">{t('takeover.title')}</h2>
			<p class="text-xs text-text-subtle mb-3 break-words">{takeoverFor.title}</p>
			{#if takeoverNote !== ''}
				<p class="text-xs text-warning mb-3" role="status" data-takeover-note>{takeoverNote}</p>
			{/if}
			{#if takeoverPreview !== null}
				<ul class="space-y-2 text-xs text-text-muted" data-takeover-lines>
					{#each takeoverLines(takeoverPreview, dayOf) as line}
						<li class="break-words" data-takeover-line={line.kind}>{line.text}</li>
					{/each}
				</ul>
			{:else if takeoverNote === ''}
				<p class="text-xs text-text-subtle">{t('takeover.loading')}</p>
			{/if}
			<div class="flex flex-wrap items-center justify-end gap-2 mt-5">
				<button
					bind:this={takeoverCancel}
					onclick={closeTakeover}
					class="rounded-[var(--radius-sm)] border border-border bg-bg-muted px-3 py-1 text-xs text-text-muted hover:bg-bg transition-colors"
				>{t('common.cancel')}</button>
				{#if previewFailed}
					<button
						onclick={reloadPreview}
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1 text-xs text-text hover:bg-bg-muted transition-colors"
						data-takeover-reload
					>{t('takeover.reload')}</button>
				{/if}
				{#if takeoverPreview !== null}
					<button
						onclick={confirmTakeover}
						disabled={takeoverBusy}
						class="rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/20 transition-colors disabled:opacity-40"
						data-takeover-confirm
					>{t('takeover.button')}</button>
				{/if}
			</div>
		</div>
	</div>
{/if}
