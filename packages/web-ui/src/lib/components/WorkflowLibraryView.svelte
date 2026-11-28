<script lang="ts">
	import { tick } from 'svelte';
	import { keptParamValues, paramAllowed } from '../workflow-param-allowed.js';
	import { goto } from '$app/navigation';
	import { getApiBase } from '../config.svelte.js';
	import { t, tf } from '../i18n.svelte.js';
	import { newChat, sendMessage } from '../stores/chat.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import StampPreviewBody from './StampPreviewBody.svelte';
	import WorkflowTakeoverDialog from './WorkflowTakeoverDialog.svelte';
	import MarkedLine from './MarkedLine.svelte';
	import DialogStatusLine from './DialogStatusLine.svelte';
	import { DIALOG_FOOT_CLASS, bringIntoReview, holdScrollPadding } from '../utils/dialog-sticky.js';
	import { shownValue, shownWhole } from '../utils/plan-takeover.js';
	import { contractLines } from '../utils/stamp-contract.js';
	import { attemptKey, clearAttemptKey, clearAllAttemptKeys, attemptIsOver } from '../utils/run-attempt-key.js';
	import { composeRunNotice, refusalBanner } from '../utils/run-notice.js';
	import { isMandateSession, isOwnerSession, loadSettingsViewer } from '../stores/settings-viewer.svelte.js';
	import { awaitsLineKey, awaitsStampRefusal, confirmOutcome, offersStamp, stillOffLine, parseStampPreview, stampChanges, visible, type StampChanges, type StampPreview } from '../utils/workflow-stamp.js';

	// The card actions show on hover only where there is room beside the name AND a pointer that
	// hovers. Below `md` they sit under the name and stay visible, and on a device without hover
	// (a phone, a tablet) they stay visible at any width — otherwise Run is unreachable there.
	// Keyboard focus reveals them everywhere.
	const revealOnHover = 'opacity-100 md:[@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100';
	// The same condition sizes them: a fingertip target (44 px) unless there is a mouse at md and
	// up, where they keep their compact desktop size.
	const actionSize = 'min-h-11 px-3 text-[12px] md:[@media(hover:hover)]:min-h-0 md:[@media(hover:hover)]:px-2 md:[@media(hover:hover)]:py-0.5 md:[@media(hover:hover)]:text-[10px]';

	// A "saved workflow" — a planned pipeline with manifest_json.template===true.
	// Surfaced by GET /api/workflows/library (PRD-WORKFLOW-UX D13).
	interface WorkflowParam {
		name: string;
		description: string;
		type: string;
	}
	interface SavedWorkflow {
		id: string;
		name: string;
		description: string;
		step_count: number;
		steps: { id: string; task: string }[];
		// Re-target schema — present (possibly empty) since the deterministic-replay
		// slice. Optional in the type so a pre-upgrade engine response still parses.
		parameters?: WorkflowParam[];
		created_at: string;
		// Slice B2: only `autonomous` workflows are cron-eligible; `capabilityContract`
		// (if any) is rendered in the consent surface. All optional for back-compat.
		mode?: string;
		// Whether a schedule may run it, by the engine's one predicate (an autonomous workflow,
		// or one whose only question tool is ask_user), and the steps that may ask the owner.
		// Absent from an older engine: then only `autonomous` is schedulable, as before.
		schedulable?: boolean;
		askingSteps?: string[];
		confirmedAt?: string;
		// The stored capability contract as the library route returns it, read only by `contractLines`.
		capabilityContract?: unknown;
		// A mandate built or changed it and the owner has not stamped what it now is (register 242).
		// Absent from an engine before the stamp: then nothing waits.
		awaitsStamp?: boolean;
		// Whom Run runs it as, when that is a person the owner let in (1055): the email, and whether
		// their access ended, which refuses the run. Sent to the owner only; absent for the owner's own.
		/** `undetermined`: the mark carries no grant id, so whose access it was cannot be told. */
		runs_as?: { person: string; ended: boolean; undetermined?: boolean; covered_by_takeover?: number };
		// Sent to a mandate for a workflow it may not schedule as it is (UX-058, ux U-085): another
		// person's, or one whose author lynox cannot read. Never whose it is.
		schedule_refusal?: 'foreign' | 'unreadable';
	}

	let workflows = $state<SavedWorkflow[]>([]);
	// Whether this instance lets a person grant a workflow unattended writes (engine feature
	// switch, reported by GET /workflows/library). Off: the dialog offers no grant fields.
	let grantEnabled = $state(false);
	// Whose session reads the library (`owner` | `mandate`), as the engine names it. Only the owner
	// stamps; absent from an older engine, which also sends no `awaitsStamp`.
	let viewer = $state<string | undefined>(undefined);
	// Running, renaming and deleting a workflow are the owner's (`ownerOnly` in http-api.ts). Whose
	// session it is comes from the shared store, which this page loads itself; the library's own
	// `viewer` counts too (`GET /api/workflows/library` sends it).
	// The buttons wait for a known owner, so a mandate never sees them, not even while the store
	// has no answer; the sentence waits for a known mandate.
	const ownerActs = $derived(viewer === 'owner' || isOwnerSession());
	const mandate = $derived(viewer === 'mandate' || isMandateSession());
	// What a parameter may take, by its contract: shown to the owner only, in the form, since a
	// refusal no longer lists it (U-362). As text, never as markup.
	function allowedFor(wf: SavedWorkflow, name: string) {
		return paramAllowed(wf.capabilityContract, name, viewer === 'owner');
	}
	function boundsHint(min: number | undefined, max: number | undefined): string {
		if (min !== undefined && max !== undefined) return tf('workflow_library.param_between', { min: String(min), max: String(max) });
		if (min !== undefined) return tf('workflow_library.param_at_least', { min: String(min) });
		if (max !== undefined) return tf('workflow_library.param_at_most', { max: String(max) });
		return '';
	}
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');

	// Per-row transient state.
	let runningId = $state<string | null>(null);
	let editingId = $state<string | null>(null);
	let editName = $state('');
	let expandedCards = $state<Set<string>>(new Set());

	// Run-time parameter modal (only opened for workflows that declare params).
	let paramModalWf = $state<SavedWorkflow | null>(null);
	let paramValues = $state<Record<string, string>>({});

	function toggleCard(id: string): void {
		const next = new Set(expandedCards);
		if (next.has(id)) next.delete(id); else next.add(id);
		expandedCards = next;
	}

	/** Loads the list; true only when the list on screen is the one just fetched. */
	async function loadWorkflows(): Promise<boolean> {
		loading = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/library?limit=100`);
			if (!res.ok) throw new Error();
			const data = (await res.json()) as { workflows: SavedWorkflow[]; grantEnabled?: boolean; viewer?: string };
			workflows = data.workflows;
			grantEnabled = data.grantEnabled === true;
			viewer = typeof data.viewer === 'string' ? data.viewer : undefined;
			loading = false;
			return true;
		} catch {
			error = t('common.load_failed');
		}
		loading = false;
		return false;
	}

	// "💬 Bearbeiten" (§4.6): editing is chat-with-context, not a bespoke step
	// form. Open a FRESH chat seeded with a typed reference to this workflow; the
	// server resolves it into a context preamble (the steps + id) so the agent
	// has the workflow loaded and can call update_workflow_steps. The user just
	// says what to change.
	function onEditInChat(wf: SavedWorkflow): void {
		newChat();
		const framing = `${t('workflow_library.edit_in_chat_prompt')} „${wf.name}".`;
		void sendMessage(framing, undefined, undefined, { context: { kind: 'workflow', id: wf.id } });
		void goto('/app');
	}

	// Run button: a workflow with parameters opens the value modal first; one
	// without runs immediately (the legacy no-arg behaviour).
	function onRunClick(wf: SavedWorkflow): void {
		if (runningId) return;
		if (wf.parameters && wf.parameters.length > 0) {
			paramValues = Object.fromEntries(wf.parameters.map((p) => [p.name, '']));
			paramModalWf = wf;
			return;
		}
		void runWorkflow(wf.id);
	}

	function submitParamModal(): void {
		const wf = paramModalWf;
		if (!wf || !wf.parameters) return;
		// Require every declared param — the engine would 400 on a missing one;
		// catch it client-side for a cleaner message.
		if (wf.parameters.some((p) => !paramValues[p.name]?.trim())) {
			error = t('workflow_library.params_required');
			return;
		}
		const params = { ...paramValues };
		paramModalWf = null;
		void runWorkflow(wf.id, params);
	}

	function cancelParamModal(): void {
		paramModalWf = null;
		error = '';
	}

	// Schedule (promote-to-cron) consent flow — the one bespoke consent gate
	// (PRD §4.6): shows the resolved capability-contract, collects the cron
	// schedule + the param values the unattended run will use, and the single
	// POST /api/tasks stamps the first-run-confirm + creates the cron task.
	let scheduleModalWf = $state<SavedWorkflow | null>(null);
	// The writes the plan dialog lists for the workflow's stored contract (`contractLines`).
	const contractShown = $derived(scheduleModalWf === null ? null : contractLines(scheduleModalWf.capabilityContract));
	/** The schedule dialog's own error: shown in the dialog, so a page error (a run, a delete) never lands
	 *  there, and a refusal of the schedule is not covered by the dialog. */
	let scheduleError = $state('');
	let scheduleCron = $state('0 9 * * *');
	let scheduling = $state(false);

	// The write grant (engine `workflow-grant.ts`): what the person types, and the preview the
	// engine returned for exactly that. Any change to an input drops the preview, so what is
	// accepted is always what was shown last; the engine checks the same with the checksum.
	let grantOpen = $state(false);
	let grantMethod = $state('POST');
	let grantHost = $state('');
	let grantPaths = $state('');
	let grantName = $state('');
	let grantAfterUntrusted = $state(false);
	interface GrantPreview { tuples: string[]; boundParams: Record<string, unknown>; binding: 'keyed' | 'unkeyed'; checksum: string }
	let grantPreview = $state<GrantPreview | null>(null);
	let previewing = $state(false);

	function grantPathList(): string[] {
		return grantPaths.split('\n').map((p) => p.trim()).filter((p) => p !== '');
	}

	function dropGrantPreview(): void {
		grantPreview = null;
	}

	// A workflow that asks its owner while it runs: it runs only on its schedule, so the library
	// offers no Run for it (the engine refuses one), and its schedule names the asking steps.
	// A workflow whose mandate's access ended runs for no one (the run is refused, 1055), so it is not
	// run, scheduled or changed from here; renaming and deleting stay (UX-053, ux U-079).
	// Its name is set apart too: `runs_as` is the mandate that made or last changed it, and a change
	// is not recorded by field, so the name may be that person's (a renamed workflow counts the same).
	function accessEnded(wf: SavedWorkflow): boolean {
		return wf.runs_as?.ended === true;
	}

	// The sentence under an ended workflow's buttons: with paused plans whose takeover moves the
	// workflow to the owner, the way through them; otherwise the workflow's own
	// takeover, whose button stands beside it.
	function endedNote(wf: SavedWorkflow): string {
		// A mark whose person cannot be told is not named by the address it carries.
		const raw = wf.runs_as?.undetermined === true ? '' : wf.runs_as?.person ?? '';
		const unnamed = raw === '' ? '_unnamed' : '';
		const person = raw === '' ? '' : shownValue(raw);
		const paused = wf.runs_as?.covered_by_takeover ?? 0;
		if (paused > 0) {
			return tf(`workflow_library.ended_note_paused_${paused === 1 ? 'one' : 'other'}${unnamed}`, {
				person, n: String(paused), tab: t('hub.automation.triggers'), button: t('takeover.button'), review: t('workflow_library.stamp.review'),
			});
		}
		return tf(`workflow_library.takeover.note${unnamed}`, { person });
	}

	// The workflow's own takeover: offered wherever its person's access ended, which is exactly where
	// the engine allows it (the library's `ended` and the takeover read the same mark and end).
	let takeoverWf = $state<SavedWorkflow | null>(null);
	// The button that opened it: focus goes back there when the dialog closes, or to the same
	// workflow's button where the list was drawn again; with none on the page, to the library's
	// heading (a card has no focusable head).
	let takeoverOpener: HTMLElement | null = null;
	let libraryHeading = $state<HTMLElement | null>(null);

	function focusAfterTakeover(opener: HTMLElement | null): void {
		const id = opener?.dataset['takeoverFor'];
		const again = opener?.isConnected === true
			? opener
			: [...document.querySelectorAll<HTMLElement>('[data-testid="takeover-open"]')].find((b) => id !== undefined && b.dataset['takeoverFor'] === id);
		if (again !== undefined) again.focus();
		else libraryHeading?.focus();
	}

	function openTakeover(wf: SavedWorkflow, opener: HTMLElement): void {
		takeoverOpener = opener;
		takeoverWf = wf;
	}

	function closeTakeover(): void {
		takeoverWf = null;
		const opener = takeoverOpener;
		takeoverOpener = null;
		focusAfterTakeover(opener);
	}

	async function takenOver(stillOff: unknown): Promise<void> {
		takeoverWf = null;
		const opener = takeoverOpener;
		takeoverOpener = null;
		error = '';
		const once = stillOffLine(stillOff);
		stampOnceLine = once ? tf(once.key, { n: String(once.n) }) : '';
		await loadWorkflows();
		notice = t('workflow_library.takeover.done');
		refocus = { opener };
	}

	// After the takeover, once the list loaded again is on screen: focus goes where
	// `focusAfterTakeover` says, but only if nothing took it meanwhile (it fell to the page when the
	// dialog closed), so a dialog or field opened during the reload keeps it.
	let refocus = $state<{ opener: HTMLElement | null } | null>(null);
	$effect(() => {
		const r = refocus;
		if (r === null) return;
		refocus = null;
		const at = document.activeElement;
		if (at === null || at === document.body) focusAfterTakeover(r.opener);
	});

	// The schedule refusals the engine names by code, in the reader's language (ux U-085, U-119).
	const SCHEDULE_REFUSALS: Record<string, string> = {
		foreign_workflow: 'workflow_library.schedule_refused.foreign',
		unreadable_workflow: 'workflow_library.schedule_refused.unreadable',
		missing_workflow: 'workflow_library.schedule_refused.missing',
		// A helper's field that reads as carrying a key (ux U-150): the server's own sentence is English.
		mandate_key_input: 'chat.mandate_key_input_other',
	};

	function asksOwner(wf: SavedWorkflow): boolean {
		return wf.mode === 'interactive' && wf.schedulable === true;
	}

	function onScheduleClick(wf: SavedWorkflow): void {
		paramValues = Object.fromEntries((wf.parameters ?? []).map((p) => [p.name, '']));
		scheduleCron = '0 9 * * *';
		scheduleError = '';
		grantOpen = false;
		grantMethod = 'POST';
		grantHost = '';
		grantPaths = '';
		grantName = '';
		grantAfterUntrusted = false;
		grantPreview = null;
		scheduleModalWf = wf;
	}

	async function previewGrant(): Promise<void> {
		const wf = scheduleModalWf;
		if (!wf || previewing) return;
		previewing = true;
		scheduleError = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/${wf.id}/grant-preview`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					method: grantMethod,
					host: grantHost,
					paths: grantPathList(),
					scheduleCron: scheduleCron.trim(),
					afterUntrusted: grantAfterUntrusted,
					...(wf.parameters && wf.parameters.length > 0 ? { params: { ...paramValues } } : {}),
				}),
			});
			const data = (await res.json().catch(() => null)) as (GrantPreview & { error?: string }) | null;
			if (!res.ok || !data || !Array.isArray(data.tuples)) {
				grantPreview = null;
				scheduleError = data?.error ?? t('workflow_library.grant_preview_failed');
				return;
			}
			grantPreview = data;
		} catch {
			scheduleError = t('workflow_library.grant_preview_failed');
		} finally {
			previewing = false;
		}
	}

	function cancelScheduleModal(): void {
		scheduleModalWf = null;
		scheduleError = '';
	}

	function onScheduleKey(e: KeyboardEvent): void {
		if (e.key === 'Enter') void submitSchedule();
		if (e.key === 'Escape') cancelScheduleModal();
	}

	async function submitSchedule(): Promise<void> {
		const wf = scheduleModalWf;
		if (!wf || scheduling) return;
		if (!scheduleCron.trim()) { scheduleError = t('workflow_library.schedule_cron_required'); return; }
		if ((wf.parameters ?? []).some((p) => !paramValues[p.name]?.trim())) {
			scheduleError = t('workflow_library.params_required');
			return;
		}
		if (grantOpen && !grantPreview) { scheduleError = t('workflow_library.grant_preview_required'); return; }
		scheduling = true;
		scheduleError = '';
		try {
			const res = await fetch(`${getApiBase()}/tasks`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pipelineId: wf.id,
					scheduleCron: scheduleCron.trim(),
					...(wf.parameters && wf.parameters.length > 0 ? { params: { ...paramValues } } : {}),
					...(grantOpen && grantPreview
						? {
							grant: {
								method: grantMethod,
								host: grantHost,
								paths: grantPathList(),
								afterUntrusted: grantAfterUntrusted,
								checksum: grantPreview.checksum,
								...(grantName.trim() ? { name: grantName.trim() } : {}),
							},
						}
						: {}),
				}),
			});
			if (!res.ok) {
				const msg = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
				// Only the owner stamps; a helper refused the same way is shown the refusal, not a view
				// whose line asks them to confirm what they cannot.
				if (awaitsStampRefusal(res.status, msg, wf.id) && viewer !== 'owner') {
					// The contract's refusal carries no text of its own.
					scheduleError = t('workflow_library.stamp.awaits_owner');
					return;
				}
				if (awaitsStampRefusal(res.status, msg, wf.id)) {
					// The way out of this refusal is the stamp itself: the steps open in place of the
					// dialog, and the dialog comes back with what was typed once they are confirmed.
					scheduleModalWf = null;
					openStamp(wf, 'awaits_at_schedule');
					stampResumesSchedule = wf;
					return;
				}
				const refused = typeof msg?.code === 'string' ? SCHEDULE_REFUSALS[msg.code] : undefined;
				scheduleError = refused !== undefined ? t(refused) : (msg?.error ?? t('workflow_library.schedule_failed'));
				return;
			}
			scheduleModalWf = null;
			notice = t('workflow_library.scheduled');
			await loadWorkflows();
		} catch {
			scheduleError = t('workflow_library.schedule_failed');
		} finally {
			scheduling = false;
		}
	}

	// The owner's stamp (register 242 (c)): the preview the engine returned, and the digest of exactly
	// what it shows. A stamp is sent only with that digest, so what is confirmed is what was shown.
	let stampWf = $state<SavedWorkflow | null>(null);
	let stampPreview = $state<StampPreview | null>(null);
	let stampLoading = $state(false);
	let stamping = $state(false);
	// Why the view is open beyond the button: the steps changed under it, or a schedule was refused
	// because the workflow waits for this stamp.
	let stampLine = $state<'steps_changed' | 'asks_changed' | 'awaits_at_schedule' | null>(null);
	// After `steps_changed`: what differs from the version shown before, marked in the steps.
	let stampChangesShown = $state<StampChanges | null>(null);
	let stampDialog = $state<HTMLElement | null>(null);
	// A schedule dialog the refusal interrupted, reopened as it was once the stamp holds.
	let stampResumesSchedule = $state<SavedWorkflow | null>(null);
	// Bumped by every load, so a late answer for an earlier opening writes nothing.
	let stampGeneration = 0;
	// Bumped by every opening and closing, so a confirm answered after its view was closed (or
	// replaced by another workflow's) acts on nothing.
	let stampOpening = 0;
	// After a stamp: plans the wait switched off, which stay off. Kept until the next review.
	let stampOnceLine = $state('');
	// The confirm button sits at the foot of the view, the line at its head: where the frame is too
	// low to keep it in sight, the line that says the steps changed would be out of sight, so it is
	// brought into view when it appears.
	let stampChangedLine = $state<HTMLElement | null>(null);
	$effect(() => {
		stampChangedLine?.scrollIntoView?.({ block: 'nearest' });
	});
	// Focus on the heading when the view opens: a reader hears what it is, and the confirm, which
	// consents to something, is not one Enter away.
	let stampHeading = $state<HTMLElement | null>(null);
	$effect(() => {
		stampHeading?.focus();
	});
	// The scrolling frame of the view: what scrolls into view in it stays clear of the parts that
	// stay in sight.
	let stampFrame = $state<HTMLElement | null>(null);
	$effect(() => {
		if (stampFrame === null) return;
		return holdScrollPadding(stampFrame);
	});
	// What opened the view, so Cancel and Escape give the focus back to it.
	let stampOpener: HTMLElement | null = null;

	/** Loads the preview; true only when this load's preview is now the one on screen. */
	async function loadStampPreview(wf: SavedWorkflow): Promise<boolean> {
		const generation = ++stampGeneration;
		stampLoading = true;
		stampPreview = null;
		stampChangesShown = null;
		try {
			const res = await fetch(`${getApiBase()}/workflows/${encodeURIComponent(wf.id)}/stamp-preview`);
			const body = res.ok ? await res.json().catch(() => null) : null;
			if (generation !== stampGeneration) return false;
			const preview = parseStampPreview(body);
			if (!preview) { error = t('common.load_failed'); return false; }
			stampPreview = preview;
			return true;
		} catch {
			if (generation === stampGeneration) error = t('common.load_failed');
		} finally {
			if (generation === stampGeneration) stampLoading = false;
		}
		return false;
	}

	function openStamp(wf: SavedWorkflow, line: 'awaits_at_schedule' | null = null): void {
		stampOpening++;
		error = '';
		notice = '';
		stampOnceLine = '';
		stampLine = line;
		stampWf = wf;
		const at = typeof document === 'undefined' ? null : document.activeElement;
		stampOpener = at instanceof HTMLElement && at !== document.body ? at : null;
		void loadStampPreview(wf);
	}

	// Cancel and Escape: the view closes and the focus goes back to what opened it. When that is gone
	// (the schedule dialog it came from, a card the list redrew), to this workflow's review button,
	// else to the library's heading, never to the page. A stamp that went through closes with
	// closeStamp alone: what comes next (the schedule dialog, the list) takes the focus.
	function cancelStamp(): void {
		const back = stampOpener;
		const id = stampWf?.id;
		closeStamp();
		void tick().then(() => {
			const again = back?.isConnected === true
				? back
				: [...document.querySelectorAll<HTMLElement>('[data-testid="stamp-review"]')].find((b) => id !== undefined && b.dataset['stampFor'] === id);
			if (again !== undefined) again.focus();
			else libraryHeading?.focus();
		});
	}

	function closeStamp(): void {
		stampOpener = null;
		stampOpening++;
		stampGeneration++;
		error = '';
		stampWf = null;
		stampPreview = null;
		stampLine = null;
		stampResumesSchedule = null;
		stamping = false;
	}

	async function confirmStamp(): Promise<void> {
		const wf = stampWf;
		const shown = stampPreview;
		if (!wf || !shown || stamping) return;
		const opening = stampOpening;
		stamping = true;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/${encodeURIComponent(wf.id)}/confirm`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ expect: shown.expect }),
			});
			const body = (await res.json().catch(() => null)) as { code?: string; stillOff?: unknown } | null;
			if (opening !== stampOpening) return;
			const outcome = confirmOutcome(res.status, body?.code);
			if (outcome.kind === 'changed') {
				// The line says the new version is shown below, so it goes up only once it is.
				stampLine = null;
				if (await loadStampPreview(wf) && opening === stampOpening && stampPreview !== null) {
					stampLine = outcome.line;
					stampChangesShown = stampChanges(shown, stampPreview);
					// Brought into sight and focused: the changed part is what the owner has to read again.
					// It goes below the line above, which says why and stays in sight while it is short and
					// the frame is high enough (DialogStatusLine).
					await tick();
					const mark = stampDialog?.querySelector<HTMLElement>('[data-stamp-changed]');
					// No marked part: the focus goes to the heading, not left where the disabled confirm
					// dropped it, so the next Enter does not confirm the new version unread.
					(mark ?? stampHeading)?.focus({ preventScroll: mark !== null });
					if (stampFrame && mark) bringIntoReview(stampFrame, mark);
				}
				return;
			}
			if (outcome.kind === 'failed') { error = t(outcome.key); return; }
			const resume = stampResumesSchedule;
			closeStamp();
			const after = stampOpening;
			// Plans the wait switched off (one that runs once, a webhook) stay off: say so, and where
			// to switch them on, or the notice promises more than the stamp did.
			// Its own line, not part of the notice: the way back to the schedule replaces the notice
			// (`reopen_schedule`, then `scheduled`), and the owner coming from there is the one most
			// likely to have such plans.
			const once = stillOffLine(body?.stillOff);
			stampOnceLine = once ? tf(once.key, { n: String(once.n) }) : '';
			notice = t('workflow_library.stamp.stamped');
			const listed = await loadWorkflows();
			// Another view opened meanwhile is the one on screen now, and the dialog stays shut. The
			// cards are hidden while a list loads, but a rename or delete answered meanwhile reloads
			// the list too and can bring them back before this reload ends.
			if (after !== stampOpening || !resume) return;
			// The dialog comes back on the workflow as it is NOW, not the one the list held before
			// the detour: its contract, asking steps and parameters are what the schedule consents
			// to. Typed values carry over where the parameter still exists, and a grant preview taken
			// before the stamp is dropped — it was computed against the old workflow.
			// Without a fresh list (reload failed) or without the workflow in it, there is nothing
			// current to reopen the dialog on — the old object is exactly what must not come back.
			const fresh = listed ? workflows.find((w) => w.id === resume.id) : undefined;
			// A workflow that may no longer be scheduled (its mandate ended, or it is not this
			// reader's to schedule) does not get the dialog back; its card now says why.
			if (fresh && (accessEnded(fresh) || fresh.schedule_refusal !== undefined)) return;
			if (!fresh) {
				notice = t('workflow_library.stamp.reopen_schedule');
				return;
			}
			// A value kept across the stamp detour stays only if it is still one of the fresh contract's values.
			paramValues = keptParamValues(fresh.parameters ?? [], paramValues, fresh.capabilityContract, viewer === 'owner');
			grantPreview = null;
			scheduleModalWf = fresh;
		} catch {
			if (opening === stampOpening) error = t('common.save_failed');
		} finally {
			if (opening === stampOpening) stamping = false;
		}
	}

	/**
	 * The attempt's key travels in the body; whether it SURVIVES the answer is decided by
	 * `attemptIsOver` in the utils module beside it — not by a flag here. A refuter killed
	 * nothing with the flag version: "never clear" and "keep on every 409" both survived,
	 * because the only witness was a regex over this file's text. The rule is a function of
	 * the answer, so it can be driven exhaustively.
	 *
	 * A thrown fetch is the one case with no answer to pass, and it is the case the key
	 * exists for: the request may have reached the engine and started spending.
	 */
	async function runWorkflow(id: string, params?: Record<string, string>): Promise<void> {
		if (runningId) return;
		runningId = id;
		error = '';
		notice = t('workflow_library.run_started');
		// Keyed on the INPUTS too: a key kept across a lost answer and then sent with
		// different values would replay the earlier run and ignore the new ones.
		const idempotencyKey = attemptKey(id, params);
		let keepKey = true;
		try {
			const res = await fetch(`${getApiBase()}/workflows/${id}/run`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(params ? { params, idempotencyKey } : { idempotencyKey })
			});
			if (res.status === 409) {
				// A refusal that is NOT a failure. Before the claim existed every non-ok
				// answer landed in the error branch below, so a correctly reported "already
				// running" would have shown as "run failed" — a red box for the one case
				// where nothing went wrong.
				const msg = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
				keepKey = !attemptIsOver({ httpStatus: 409, code: msg?.code });
				// ⚠ The message is chosen by CODE, never by whether the key survives. Those
				// two coincided until `run_outcome_unknown` became non-terminal, and then the
				// branch on `keepKey` sent that code into the "already running" banner — a
				// sentence that is false for it — while the specific wording written for it
				// became unreachable. Two questions, two conditions.
				// Composed in `run-notice.ts`, for the reason recorded there: as an if/else chain
				// here, a one-line change that prepended a code to the first condition restored
				// the defect this branch had just fixed, with every test green — the witnesses
				// were regexes over this file and cannot see reachability.
				const banner = refusalBanner(msg?.code);
				notice = banner.kind === 'notice' ? t(banner.key) : '';
				error = banner.kind === 'error' ? t(banner.key) : '';
				if (msg?.code === 'run_outcome_unknown') {
					// ⚠ The ONE state where the earlier run may still be alive and still
					// spending. The key is kept (so no click can silently duplicate it), and
					// the only way out is this question — asked once, naming the consequence,
					// and answered by the person rather than decided here.
					//
					// This replaced a sentence that told the owner to click again, while the
					// client discarded the key on the same answer: the server refused because a
					// run may still be paying, and the client undid the refusal on the next
					// click. Releasing is now an act, not a side effect.
					//
					// It does NOT re-run. The release and the run are two decisions, so the
					// confirm cannot turn into a second run the person did not separately ask
					// for.
					if (confirm(t('workflow_library.run_outcome_unknown_force'))) {
						clearAttemptKey(id, params);
						error = '';
						notice = t('workflow_library.run_outcome_unknown_released');
					}
				}
				return;
			}
			if (!res.ok) {
				// ⚠ `attemptIsOver` decides, NOT `res.ok`. A 502/503/504 from a proxy, or a
				// 429, is an answer the route never produced — the engine may still be running
				// and spending. Discarding the key there is what lets the next click pay for
				// the whole workflow a second time.
				keepKey = !attemptIsOver({ httpStatus: res.status });
				const msg = (await res.json().catch(() => null)) as { error?: string; code?: string; runs_as?: string | null } | null;
				// The person who shaped it has left (1055, ux U-063): name them and the way out, a new
				// workflow from the chat, rather than the engine's sentence.
				// Named, because the message stands above the list, apart from the workflow's card.
				const name = workflows.find((w) => w.id === id)?.name ?? id;
				if (msg?.code === 'author_ended') {
					// The way out is the workflow's takeover, whose button the list shows once it reads the
					// end: read it again, then say where the button is.
					notice = '';
					await loadWorkflows();
					const undetermined = workflows.find((w) => w.id === id)?.runs_as?.undetermined === true;
					error = typeof msg.runs_as === 'string' && msg.runs_as !== '' && !undetermined
						? tf('workflow_library.takeover.author_ended', { person: shownValue(msg.runs_as), name: shownValue(name) })
						: tf('workflow_library.takeover.author_ended_unnamed', { name: shownValue(name) });
					return;
				}
				error = msg?.error ?? t('workflow_library.run_failed');
				notice = '';
				return;
			}
			// A2: the run endpoint now returns cost + per-step failures, so the
			// library shows WHICH step failed and the spend right where the run was
			// triggered — not just a terminal status.
			const data = (await res.json()) as {
				status?: string;
				costUsd?: number;
				error?: string;
				idempotent?: boolean;
				restartedFrom?: string;
				previousCostUsd?: number;
				stepErrors?: Array<{ stepId: string; error?: string; costUsd: number }>;
			};
			// ⚠ HERE, and not before the parse. The attempt is over once its outcome is in
			// hand; a 200 whose body never arrives is an answer the client did not receive,
			// and clearing the key there would make the next click pay for a run that had
			// already succeeded. Deleting this line reintroduces "never clear" — after which
			// a successful run replays for ever and the workflow can never be run again, so
			// it is witnessed in both directions.
			keepKey = !attemptIsOver({ httpStatus: res.status });
			// Composed in `run-notice.ts`, where every shape it can take is drivable. It went
			// wrong twice as template literals here, both times in a sentence about money.
			// `tf` where a string has a slot, `t` otherwise — one closure, so the module needs
			// no knowledge of which keys carry placeholders.
			const composed = composeRunNotice(data, (key, vars) => (vars === undefined ? t(key) : tf(key, vars)));
			if (composed.kind === 'notice') {
				notice = composed.text;
				error = '';
			} else {
				error = composed.text;
				notice = '';
			}
		} catch {
			// The answer never arrived, so whether the run started is unknown HERE — and that
			// is precisely the case the key is for. `keepKey` starts true, so this needs no
			// assignment: every exit that does NOT reach an answer keeps the key, which is the
			// safe default and the reason the initial value is `true` rather than `false`.
			error = t('workflow_library.run_failed');
			notice = '';
		} finally {
			if (!keepKey) clearAttemptKey(id, params);
			runningId = null;
		}
	}

	function startRename(wf: SavedWorkflow): void {
		editingId = wf.id;
		editName = wf.name;
	}

	function cancelRename(): void {
		editingId = null;
		editName = '';
	}

	async function saveRename(id: string): Promise<void> {
		const name = editName.trim();
		if (!name) return;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (!res.ok) {
				// The field stays open, so the owner can type the name again (ux U-077).
				const body = await res.json().catch(() => null) as { code?: unknown } | null;
				error = body?.code === 'hidden_char' ? t('workflow_library.rename_hidden_char') : t('common.save_failed');
				return;
			}
			editingId = null;
			editName = '';
			await loadWorkflows();
		} catch {
			error = t('common.save_failed');
		}
	}

	async function deleteWorkflow(id: string): Promise<void> {
		if (!confirm(t('workflow_library.delete_confirm'))) return;
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/${id}`, { method: 'DELETE' });
			if (!res.ok) { error = t('common.save_failed'); return; }
			// No answer can ever be terminal for a workflow that is gone, so its attempt keys
			// would stay in storage for good. Nothing else removes them.
			clearAllAttemptKeys(id);
			await loadWorkflows();
		} catch {
			error = t('common.save_failed');
		}
	}

	$effect(() => { void loadWorkflows(); void loadSettingsViewer(); /* both catch their errors */ });
</script>

<div class="p-6 max-w-4xl mx-auto">
	<h1 bind:this={libraryHeading} tabindex="-1" class="text-xl font-light tracking-tight mb-4">{t('workflow_library.title')}</h1>

	{#if error}
		<div data-page-error class="rounded-[var(--radius-md)] bg-danger/10 border border-danger/20 px-4 py-3 text-sm text-danger mb-4"><MarkedLine text={error} /></div>
	{/if}
	{#if notice}
		<div class="rounded-[var(--radius-md)] bg-success/10 border border-success/20 px-4 py-3 text-sm text-success mb-4">{notice}</div>
	{/if}
	{#if stampOnceLine}
		<div role="status" data-testid="stamp-once" class="rounded-[var(--radius-md)] bg-warning/10 border border-warning/30 px-4 py-3 text-sm mb-4">{stampOnceLine}</div>
	{/if}

	{#if loading}
		<p class="text-text-subtle text-sm">{t('common.loading')}</p>
	{:else if workflows.length > 0}
		{#if mandate}
			<p class="border border-border rounded p-3 text-sm text-text-muted mb-4" data-testid="owner-only-notice">{t('workflow_library.owner_only_notice')}</p>
		{/if}
		<div class="space-y-2">
			{#each workflows as wf (wf.id)}
				<div class="rounded-[var(--radius-md)] border border-border bg-bg-subtle px-4 py-3 group">
					<div class="flex flex-col gap-2 md:flex-row md:items-start md:justify-between md:gap-3">
						<div class="flex-1 min-w-0">
							{#if editingId === wf.id}
								<input
									bind:value={editName}
									onkeydown={(e) => { if (e.key === 'Enter') void saveRename(wf.id); if (e.key === 'Escape') cancelRename(); }}
									aria-label={t('workflow_library.rename')}
									class="w-full min-h-11 md:[@media(hover:hover)]:min-h-0 rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
								/>
							{:else}
								<!-- A workflow a person with access made or last changed (`runs_as`, sent to the owner only):
								     its name may be that person's, so it is set apart, as in the sentence below it. -->
								<p class="text-sm font-medium line-clamp-2 break-words" data-workflow-title>{#if accessEnded(wf) || wf.runs_as}<MarkedLine text={shownValue(wf.name)} mono={false} />{:else}{wf.name}{/if}</p>
								{#if wf.description}
									<p class="text-xs text-text-subtle mt-1 line-clamp-2 break-words">{wf.description}</p>
								{/if}
								<div class="flex flex-wrap gap-2 mt-1.5 text-xs text-text-subtle">
									{#if wf.steps.length > 0}
										<button
											onclick={() => toggleCard(wf.id)}
											aria-expanded={expandedCards.has(wf.id)}
											class="flex items-center gap-1 rounded-[var(--radius-sm)] hover:text-text transition-colors"
										>
											<Icon name="workflow" size="xs" />
											{t(wf.step_count === 1 ? 'workflow_library.steps_one' : 'workflow_library.steps_many').replace('{count}', String(wf.step_count))}
											<Icon name="chevron_down" size="xs" class="transition-transform {expandedCards.has(wf.id) ? 'rotate-180' : ''}" />
										</button>
									{:else}
										<span class="flex items-center gap-1">
											<Icon name="workflow" size="xs" />
											{t(wf.step_count === 1 ? 'workflow_library.steps_one' : 'workflow_library.steps_many').replace('{count}', String(wf.step_count))}
										</span>
									{/if}
									{#if wf.awaitsStamp === true}
										<span data-testid="stamp-badge" class="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 px-1.5 text-warning">
											<Icon name="warning" size="xs" />
											{t('workflow_library.stamp.awaits')}
										</span>
									{/if}
									{#if wf.runs_as && accessEnded(wf)}
										<span data-testid="access-ended-badge" class="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 px-1.5 text-warning break-all">
											<Icon name="warning" size="xs" />
											<!-- Without the address: the sentence below names the person, set apart. -->
											{t('workflow_library.access_ended_unnamed')}
										</span>
									{:else if wf.runs_as}
										<span data-testid="runs-as-badge" class="inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-bg px-1.5 break-all">
											<!-- One flex item: the sentence's own space keeps the box from "als". -->
											<span><MarkedLine text={tf('workflow_library.runs_as', { person: shownValue(wf.runs_as.person) })} /></span>
										</span>
									{/if}
								</div>
								{#if expandedCards.has(wf.id)}
									<div class="space-y-1 mt-2">
										{#each wf.steps as step (step.id)}
											<div class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2">
												<p class="font-mono text-xs text-text-subtle truncate">{step.id}</p>
												<p class="text-[10px] uppercase tracking-widest text-text-subtle mt-1 mb-0.5">{t('workflow.task')}</p>
												<p class="text-xs text-text break-words">{step.task}</p>
											</div>
										{/each}
									</div>
								{/if}
							{/if}
						</div>
						<div class="flex flex-wrap items-center gap-2 md:max-w-[50%] lg:max-w-none md:shrink-0 md:justify-end md:mt-0.5">
							{#if editingId === wf.id}
								<button onclick={() => void saveRename(wf.id)} class="inline-flex items-center rounded-[var(--radius-sm)] border border-success/30 bg-success/10 {actionSize} text-success hover:bg-success/20 transition-colors">{t('workflow_library.save')}</button>
								<button onclick={cancelRename} class="inline-flex items-center rounded-[var(--radius-sm)] border border-border bg-bg-muted {actionSize} text-text-muted hover:bg-bg transition-colors">{t('workflow_library.cancel')}</button>
							{:else}
								{#if accessEnded(wf) && ownerActs}
									<!-- Always visible, not on hover: it is the one way this workflow runs again. -->
									<button
										data-testid="takeover-open"
										data-takeover-for={wf.id}
										onclick={(e) => openTakeover(wf, e.currentTarget)}
										class="flex items-center gap-1 rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 {actionSize} text-warning hover:bg-warning/20 transition-colors"
									>
										<Icon name="warning" size="xs" />
										{t('workflow_library.takeover.button')}
									</button>
								{/if}
								{#if offersStamp(wf, viewer)}
									<!-- Always visible, not on hover: it is the one thing this workflow waits for. -->
									<button
										data-testid="stamp-review"
										data-stamp-for={wf.id}
										onclick={() => openStamp(wf)}
										class="flex items-center gap-1 rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 {actionSize} text-warning hover:bg-warning/20 transition-colors"
									>
										<Icon name="warning" size="xs" />
										{t('workflow_library.stamp.review')}
									</button>
								{/if}
								{#if !asksOwner(wf) && ownerActs}
								<button
									onclick={() => onRunClick(wf)}
									disabled={runningId !== null || accessEnded(wf)}
									class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 {actionSize} text-accent-text hover:bg-accent/20 transition-opacity disabled:cursor-not-allowed disabled:opacity-50 md:[@media(hover:hover)]:disabled:opacity-0 group-hover:disabled:opacity-50 group-focus-within:disabled:opacity-50"
								>
									<Icon name="bolt" size="xs" />
									{runningId === wf.id ? t('workflow_library.running') : t('workflow_library.run')}
								</button>
								{/if}
								{#if wf.schedulable ?? wf.mode === 'autonomous'}
									<button
										onclick={() => onScheduleClick(wf)}
										disabled={accessEnded(wf) || wf.schedule_refusal !== undefined}
										class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 {actionSize} text-accent-text hover:bg-accent/20 transition-opacity disabled:cursor-not-allowed disabled:opacity-50 md:[@media(hover:hover)]:disabled:opacity-0 group-hover:disabled:opacity-50 group-focus-within:disabled:opacity-50"
									>
										<Icon name="clock" size="xs" />
										{t('workflow_library.schedule')}
									</button>
								{/if}
								<button
									onclick={() => onEditInChat(wf)}
									disabled={accessEnded(wf)}
									class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 {actionSize} text-accent-text hover:bg-accent/20 transition-opacity disabled:cursor-not-allowed disabled:opacity-50 md:[@media(hover:hover)]:disabled:opacity-0 group-hover:disabled:opacity-50 group-focus-within:disabled:opacity-50"
								>
									<Icon name="chat" size="xs" />
									{t('workflow_library.edit_in_chat')}
								</button>
								{#if ownerActs}
								<button onclick={() => startRename(wf)} class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-border bg-bg-muted {actionSize} text-text-muted hover:bg-bg transition-opacity">
									<Icon name="pencil" size="xs" />
									{t('workflow_library.rename')}
								</button>
								<button onclick={() => void deleteWorkflow(wf.id)} class="flex items-center gap-1 {revealOnHover} rounded-[var(--radius-sm)] border border-danger/30 bg-danger/10 {actionSize} text-danger hover:bg-danger/20 transition-opacity">
									<Icon name="trash" size="xs" />
									{t('workflow_library.delete')}
								</button>
								{/if}
							{/if}
						</div>
					</div>
					<!-- Why a button above is off, in the open, not in a tooltip (ux U-079, U-119). -->
					{#if accessEnded(wf)}
						<p data-library-note="ended" class="mt-2 text-xs text-warning break-words"><MarkedLine text={endedNote(wf)} /></p>
					{:else if wf.schedule_refusal !== undefined && (wf.schedulable ?? wf.mode === 'autonomous')}
						<p data-library-note={wf.schedule_refusal} class="mt-2 text-xs text-text-muted break-words">{t(`workflow_library.${wf.schedule_refusal}_note`)}</p>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="text-center py-12 text-text-subtle">
			<p class="text-sm">{t('workflow_library.empty')}</p>
			<p class="text-xs mt-2">{t('workflow_library.empty_hint')}</p>
		</div>
	{/if}
</div>

{#if paramModalWf}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
		role="dialog"
		aria-modal="true"
		aria-label={t('workflow_library.params_title')}
	>
		<div class="w-full max-w-md rounded-[var(--radius-md)] border border-border bg-bg p-5 shadow-lg">
			<h2 class="text-sm font-medium mb-1 break-words" data-params-title>{#if paramModalWf.runs_as}<MarkedLine text={shownWhole(paramModalWf.name)} mono={false} />{:else}{paramModalWf.name}{/if}</h2>
			<p class="text-xs text-text-subtle mb-4">{t('workflow_library.params_hint')}</p>
			<div class="space-y-3">
				{#each paramModalWf.parameters ?? [] as param (param.name)}
					{@const allowed = allowedFor(paramModalWf, param.name)}
					<label class="block">
						<span class="block text-xs font-medium mb-1">{param.name}</span>
						{#if param.description}
							<span class="block text-[10px] text-text-subtle mb-1">{param.description}</span>
						{/if}
						{#if allowed?.values}
							<select
								bind:value={paramValues[param.name]}
								data-param-choice={param.name}
								onkeydown={(e) => { if (e.key === 'Escape') cancelParamModal(); }}
								class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
							>
								<option value="">{t('workflow_library.param_choose')}</option>
								{#each allowed.values as v (v)}
									<option value={v}>{v}</option>
								{/each}
							</select>
						{:else}
							<input
							bind:value={paramValues[param.name]}
							type={param.type === 'date' ? 'date' : 'text'}
							inputmode={param.type === 'number' ? 'decimal' : undefined}
							onkeydown={(e) => { if (e.key === 'Enter') submitParamModal(); if (e.key === 'Escape') cancelParamModal(); }}
							class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
						/>
						{/if}
						{#if allowed && (allowed.min !== undefined || allowed.max !== undefined)}
							<span data-param-bounds={param.name} class="block text-[10px] text-text-subtle mt-1">{boundsHint(allowed.min, allowed.max)}</span>
						{/if}
					</label>
				{/each}
			</div>
			<div class="flex items-center justify-end gap-2 mt-5">
				<button
					onclick={cancelParamModal}
					class="rounded-[var(--radius-sm)] border border-border bg-bg-muted px-3 py-1 text-xs text-text-muted hover:bg-bg transition-colors"
				>{t('workflow_library.cancel')}</button>
				<button
					onclick={submitParamModal}
					class="flex items-center gap-1 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/20 transition-colors"
				>
					<Icon name="bolt" size="xs" />
					{t('workflow_library.run')}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if scheduleModalWf}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
		role="dialog"
		aria-modal="true"
		aria-label={t('workflow_library.schedule_title')}
	>
		<div class="w-full max-w-md rounded-[var(--radius-md)] border border-border bg-bg p-5 shadow-lg max-h-[85vh] overflow-y-auto">
			<h2 class="text-sm font-medium mb-1 break-words" data-schedule-title>{#if scheduleModalWf.runs_as}<MarkedLine text={`${t('workflow_library.schedule_title')}: ${shownWhole(scheduleModalWf.name)}`} mono={false} />{:else}{t('workflow_library.schedule_title')}: {scheduleModalWf.name}{/if}</h2>
			<!-- "unattended" is false for a workflow that asks its owner while it runs. -->
			<p class="text-xs text-text-subtle mb-4">{t(asksOwner(scheduleModalWf) ? 'workflow_library.schedule_hint_asks' : 'workflow_library.schedule_hint')}</p>

			{#if asksOwner(scheduleModalWf) && (scheduleModalWf.askingSteps ?? []).length > 0}
				<div class="rounded-[var(--radius-sm)] border border-border bg-bg-muted p-3 mb-4 text-xs">
					<p class="font-medium mb-1 flex items-center gap-1"><Icon name="chat" size="xs" />{t('workflow_library.schedule_asks_title')}</p>
					<ul class="space-y-0.5 text-text-subtle font-mono">
						{#each scheduleModalWf.askingSteps ?? [] as stepId (stepId)}
							<li>{stepId}</li>
						{/each}
					</ul>
				</div>
			{/if}

			<!-- What the stored contract lets a run write without asking, as the engine grants it
			     (`contractLines`): only `http_request`, only the methods, hosts and paths it names. A
			     contract that grants nothing says so (U-451); no other tool is listed, none is granted. -->
			{#if contractShown !== null && contractShown.length === 0}
				<p data-testid="schedule-contract-none" class="mb-4 text-xs text-text-subtle">{t('workflow_library.contract_none')}</p>
			{:else if contractShown !== null}
				<div class="rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 p-3 mb-4 text-xs">
					<p class="font-medium mb-1 flex items-center gap-1"><Icon name="warning" size="xs" />{t('workflow_library.schedule_contract_title')}</p>
					<ul class="space-y-0.5 text-text-subtle font-mono">
						<!-- Keyed by position: a cross product can list the same tuple twice. -->
						{#each contractShown as line, i (i)}
							<li class="break-all">{visible(line)}</li>
						{/each}
					</ul>
				</div>
			{/if}

			<label class="block mb-3">
				<span class="block text-xs font-medium mb-1">{t('workflow_library.schedule_cron_label')}</span>
				<span class="block text-[10px] text-text-subtle mb-1">{t('workflow_library.schedule_cron_hint')}</span>
				<input
					bind:value={scheduleCron}
					placeholder="0 9 * * *"
					oninput={dropGrantPreview}
					onkeydown={onScheduleKey}
					class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 font-mono text-[16px] md:text-sm focus:border-accent focus:outline-none"
				/>
			</label>

			{#if (scheduleModalWf.parameters ?? []).length > 0}
				<div class="space-y-3 mb-1">
					<p class="text-[10px] uppercase tracking-widest text-text-subtle">{t('workflow_library.params_title')}</p>
					{#each scheduleModalWf.parameters ?? [] as param (param.name)}
						{@const allowed = allowedFor(scheduleModalWf, param.name)}
						<label class="block">
							<span class="block text-xs font-medium mb-1">{param.name}</span>
							{#if param.description}
								<span class="block text-[10px] text-text-subtle mb-1">{param.description}</span>
							{/if}
							{#if allowed?.values}
								<select
									bind:value={paramValues[param.name]}
									data-param-choice={param.name}
									onchange={dropGrantPreview}
									class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
								>
									<option value="">{t('workflow_library.param_choose')}</option>
									{#each allowed.values as v (v)}
										<option value={v}>{v}</option>
									{/each}
								</select>
							{:else}
							<input
								bind:value={paramValues[param.name]}
								type={param.type === 'date' ? 'date' : 'text'}
								inputmode={param.type === 'number' ? 'decimal' : undefined}
								oninput={dropGrantPreview}
								onkeydown={onScheduleKey}
								class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none"
							/>
							{/if}
							{#if allowed && (allowed.min !== undefined || allowed.max !== undefined)}
								<span data-param-bounds={param.name} class="block text-[10px] text-text-subtle mt-1">{boundsHint(allowed.min, allowed.max)}</span>
							{/if}
						</label>
					{/each}
				</div>
			{/if}

			{#if grantEnabled}
				<div class="mt-4 rounded-[var(--radius-sm)] border border-border p-3 text-xs">
					<label class="flex items-center gap-2 font-medium">
						<input type="checkbox" bind:checked={grantOpen} onchange={dropGrantPreview} />
						{t('workflow_library.grant_toggle')}
					</label>
					{#if grantOpen}
						<p class="mt-2 text-[10px] text-text-subtle">{t('workflow_library.grant_hint')}</p>
						<div class="mt-3 grid grid-cols-[auto_1fr] items-center gap-2">
							<span>{t('workflow_library.grant_method')}</span>
							<select bind:value={grantMethod} onchange={dropGrantPreview} class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm">
								<option value="POST">POST</option>
								<option value="PUT">PUT</option>
								<option value="PATCH">PATCH</option>
							</select>
							<span>{t('workflow_library.grant_host')}</span>
							<input bind:value={grantHost} oninput={dropGrantPreview} placeholder="api.example.com" autocomplete="off" class="rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 font-mono text-[16px] md:text-sm focus:border-accent focus:outline-none" />
						</div>
						<label class="mt-2 block">
							<span class="block mb-1">{t('workflow_library.grant_paths')}</span>
							<textarea bind:value={grantPaths} oninput={dropGrantPreview} rows="3" placeholder="/v1/reports" class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 font-mono text-[16px] md:text-sm focus:border-accent focus:outline-none"></textarea>
						</label>
						<label class="mt-2 flex items-start gap-2">
							<input type="checkbox" bind:checked={grantAfterUntrusted} onchange={dropGrantPreview} class="mt-0.5" />
							<span>{t('workflow_library.grant_after_untrusted')}<span class="block text-[10px] text-text-subtle">{t('workflow_library.grant_after_untrusted_hint')}</span></span>
						</label>
						<label class="mt-2 block">
							<span class="block mb-1">{t('workflow_library.grant_name')}</span>
							<input bind:value={grantName} autocomplete="name" class="w-full rounded-[var(--radius-sm)] border border-border bg-bg-subtle px-2 py-1 text-[16px] md:text-sm focus:border-accent focus:outline-none" />
						</label>
						<button
							onclick={previewGrant}
							disabled={previewing}
							class="mt-3 rounded-[var(--radius-sm)] border border-border bg-bg-muted px-3 py-1 text-xs hover:bg-bg transition-colors disabled:opacity-50"
						>{t('workflow_library.grant_preview')}</button>
						{#if grantPreview}
							<div class="mt-3 rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 p-2">
								<p class="font-medium mb-1">{t('workflow_library.grant_preview_title')}</p>
								<ul class="space-y-0.5 font-mono text-text-subtle">
									{#each grantPreview.tuples as line (line)}
										<li>{line}</li>
									{/each}
								</ul>
								{#if Object.keys(grantPreview.boundParams).length > 0}
									<p class="mt-2 font-medium">{t('workflow_library.grant_values')}</p>
									<ul class="space-y-1 font-mono text-text-subtle">
										{#each Object.entries(grantPreview.boundParams) as [name, value] (name)}
											<!-- Each value sits in its own box, so a line break inside it does not start what
											     reads as a second `name = value` row. break-spaces keeps trailing and all-space values
											     visible, break-all wraps a long value inside the dialog, overflow-hidden keeps
											     stacked marks from painting over the rows above, and <bdi> stops right-to-left
											     text from reordering the name and the `=`. -->
											<li><bdi class="whitespace-break-spaces">{name}</bdi> =
												<span class="mt-0.5 block overflow-hidden break-all whitespace-break-spaces rounded border border-border px-1"><bdi>{String(value)}</bdi></span>
											</li>
										{/each}
									</ul>
								{/if}
								{#if grantAfterUntrusted}
									<p class="mt-2">{t('workflow_library.grant_after_untrusted_on')}</p>
								{/if}
								{#if grantPreview.binding === 'unkeyed'}
									<p class="mt-2 flex items-center gap-1"><Icon name="warning" size="xs" />{t('workflow_library.grant_unkeyed')}</p>
								{/if}
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			<!-- In the dialog: on the page behind it, a refusal is covered by the dialog that stays open. -->
			{#if scheduleError}
				<p data-schedule-error class="rounded-[var(--radius-sm)] bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger mt-4">{scheduleError}</p>
			{/if}
			<div class="flex items-center justify-end gap-2 mt-5">
				<button
					onclick={cancelScheduleModal}
					class="rounded-[var(--radius-sm)] border border-border bg-bg-muted px-3 py-1 text-xs text-text-muted hover:bg-bg transition-colors"
				>{t('workflow_library.cancel')}</button>
				<button
					onclick={submitSchedule}
					disabled={scheduling}
					class="flex items-center gap-1 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/20 transition-colors disabled:opacity-50"
				>
					<Icon name="clock" size="xs" />
					{t('workflow_library.schedule_confirm')}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Escape once the focus fell to the page (a confirm that was turned off): the view is the only
	 dialog open then, and the key is its. -->
<svelte:window onkeydown={(e) => { if (stampWf && e.key === 'Escape' && (document.activeElement === null || document.activeElement === document.body)) cancelStamp(); }} />
{#if stampWf}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="workflow-stamp-title"
		tabindex="-1"
		data-testid="stamp-dialog"
		bind:this={stampDialog}
		onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancelStamp(); } }}
	>
		<div bind:this={stampFrame} class="w-full max-w-2xl rounded-[var(--radius-md)] border border-border bg-bg p-5 shadow-lg max-h-[85vh] overflow-y-auto">
			<!-- Where the owner approves the steps: a name a person with access gave is set apart, whole. -->
			<h2 id="workflow-stamp-title" bind:this={stampHeading} tabindex="-1" class="text-sm font-medium mb-1 break-words" data-stamp-review-title>{#if stampWf.runs_as}<MarkedLine text={`${t('workflow_library.stamp.review')}: ${shownWhole(stampWf.name)}`} mono={false} />{:else}{t('workflow_library.stamp.review')}: {visible(stampWf.name)}{/if}</h2>
			{#if stampLine === 'steps_changed' || stampLine === 'asks_changed'}
				<DialogStatusLine text={t(stampLine === 'asks_changed' ? 'workflow_library.stamp.refused.asks_changed' : 'workflow_library.stamp.refused.steps_changed')} testid="stamp-line" bind:el={stampChangedLine} />
			{:else if stampLine === 'awaits_at_schedule' && stampPreview}
				<!-- Worded by who changed it, which only the preview says: the line waits for it. -->
				<DialogStatusLine text={t(awaitsLineKey(stampPreview.changedBy))} testid="stamp-line" />
			{:else if stampLine === 'awaits_at_schedule' && !stampLoading}
				<!-- The preview did not load, so who changed it is unknown: the line says why, not who. -->
				<DialogStatusLine text={t('workflow_library.stamp.awaits_at_schedule_unloaded')} testid="stamp-line" />
			{/if}
			<!-- The schedule's line for a preview that did not load already says it did not load. -->
			{#if error && !(stampLine === 'awaits_at_schedule' && !stampPreview && !stampLoading)}
				<p class="rounded-[var(--radius-sm)] bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger mb-3"><MarkedLine text={error} /></p>
			{/if}
			<!-- "This is what runs" only above something that runs: without a preview it introduces nothing. -->
			{#if stampPreview}
				<p class="text-xs text-text-subtle mb-3">{t('workflow_library.stamp.intro')}</p>
			{/if}

			{#if stampLoading}
				<p class="text-text-subtle text-sm">{t('common.loading')}</p>
			{:else if stampPreview}
				<StampPreviewBody preview={stampPreview} changes={stampChangesShown} asksNone={stampLine === 'asks_changed'} />
			{/if}

			<div data-dialog-foot class={DIALOG_FOOT_CLASS}>
				<button
					onclick={cancelStamp}
					class="min-h-11 md:min-h-0 rounded-[var(--radius-sm)] border border-border bg-bg-muted px-3 py-1 text-xs text-text-muted hover:bg-bg transition-colors"
				>{t('workflow_library.cancel')}</button>
				<button
					data-testid="stamp-confirm"
					onclick={confirmStamp}
					disabled={stampPreview === null || stampLoading || stamping}
					class="min-h-11 md:min-h-0 flex items-center gap-1 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{t('workflow_library.stamp.confirm')}
				</button>
			</div>
		</div>
	</div>
{/if}

{#if takeoverWf}
	<WorkflowTakeoverDialog workflow={takeoverWf} onclose={closeTakeover} ondone={(stillOff) => void takenOver(stillOff)} onstale={() => void loadWorkflows()} />
{/if}
