<script lang="ts">
	import { tick } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import { t, tf } from '../i18n.svelte.js';
	import StampPreviewBody from './StampPreviewBody.svelte';
	import MarkedLine from './MarkedLine.svelte';
	import DialogStatusLine from './DialogStatusLine.svelte';
	import { FoldGroup } from '../utils/fold-group.svelte.js';
	import { shownValue } from '../utils/plan-takeover.js';
	import { DIALOG_FOOT_CLASS, bringIntoReview } from '../utils/dialog-sticky.js';
	import { stampChanges, type StampChanges } from '../utils/workflow-stamp.js';
	import {
		markLine, parseWorkflowTakeoverPreview, refusalNamesSupport, stepConnectionNote, takeoverOutcome, takeoverRefusalText, workflowTakeoverLines,
		type WorkflowTakeoverPreview,
	} from '../utils/workflow-takeover.js';

	// The owner's takeover of a workflow whose person's access ended: what it covers and stamps, read
	// from the engine's preview, and the one act that takes it over against the digest of exactly
	// what was shown.
	let { workflow, onclose, ondone, onstale }: {
		workflow: { id: string; name: string };
		onclose: () => void;
		ondone: (stillOff: unknown) => void;
		/** The library's list is out of date: the workflow no longer needs taking over. */
		onstale: () => void;
	} = $props();

	let preview = $state<WorkflowTakeoverPreview | null>(null);
	// The lists of plans this preview has unfolded: a new preview starts folded.
	const folds = $derived(preview === null ? undefined : new FoldGroup());
	let loading = $state(true);
	let sending = $state(false);
	let error = $state('');
	// Set once a takeover was refused because something shown moved, and the new state is shown.
	let changedLine = $state('');
	// Then: what differs from the version shown before, marked in the stamp part.
	let changes = $state<StampChanges | null>(null);
	let generation = 0;
	let dialog = $state<HTMLElement | null>(null);
	let heading = $state<HTMLElement | null>(null);
	let errorLine = $state<HTMLElement | null>(null);
	let changedEl = $state<HTMLElement | null>(null);

	// Focus on the heading when the dialog opens: a reader hears what it is, and the confirm, which
	// consents to something, is not one Enter away.
	$effect(() => {
		heading?.focus();
	});
	// The buttons sit at the foot, these lines at the head: where the frame is too low to keep them
	// in sight, they would be out of sight.
	$effect(() => {
		errorLine?.scrollIntoView?.({ block: 'nearest' });
	});
	$effect(() => {
		changedEl?.scrollIntoView?.({ block: 'nearest' });
	});

	// A key is the dialog's when focus is in it, or nowhere (a reload, or a button turned off, can
	// take the focused element); focus in an overlay above it, such as the command palette, keeps
	// Escape and Tab for that.
	function keyIsOurs(): boolean {
		const at = document.activeElement;
		return at === null || at === document.body || (dialog?.contains(at) ?? false);
	}

	// Tab stays inside while the dialog is open: the page behind it is not reachable, also from
	// where focus fell to the page when what held it went away.
	function trapTab(e: KeyboardEvent): void {
		if (e.key !== 'Tab' || dialog === null) return;
		const stops = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
		if (stops.length === 0) { e.preventDefault(); return; }
		const first = stops[0]!;
		const last = stops[stops.length - 1]!;
		const at = document.activeElement;
		if (e.shiftKey && (at === first || at === heading || !dialog.contains(at))) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && (at === last || !dialog.contains(at))) { e.preventDefault(); first.focus(); }
	}

	// Whether lynox hosts this instance, for the support line under a lasting failure. Unknown reads
	// as not hosted, so no address is offered that may not help.
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

	async function load(): Promise<boolean> {
		const mine = ++generation;
		loading = true;
		preview = null;
		// What a confirm found changed belongs to the version it was shown: a load starts without it,
		// and the confirm that loads sets it again once the new version is shown.
		changes = null;
		changedLine = '';
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/${encodeURIComponent(workflow.id)}/takeover-preview`);
			const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
			if (mine !== generation) return false;
			if (res.ok && body !== null && typeof body['refusal'] === 'string') {
				const code = body['refusal'];
				const managed = refusalNamesSupport(code) ? await isHosted() : false;
				if (mine !== generation) return false;
				error = takeoverRefusalText(code, managed, typeof body['message'] === 'string' ? body['message'] : t('common.load_failed'));
				if (code === 'nothing_to_take_over') onstale();
				return false;
			}
			const parsed = res.ok ? parseWorkflowTakeoverPreview(body) : null;
			if (parsed === null) { error = t('common.load_failed'); return false; }
			preview = parsed;
			return true;
		} catch {
			if (mine === generation) error = t('common.load_failed');
			return false;
		} finally {
			if (mine === generation) loading = false;
		}
	}

	// Loaded once the dialog opens, and again for another workflow (the only state it reads before
	// its first await is the workflow's id).
	$effect(() => {
		void load();
	});

	async function confirm(): Promise<void> {
		const shown = preview;
		if (shown === null || sending) return;
		sending = true;
		error = '';
		// Set only when this confirm reloaded a moved version: then the focus goes to what changed.
		let toMark = false;
		try {
			const res = await fetch(`${getApiBase()}/workflows/${encodeURIComponent(workflow.id)}/takeover`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ expect: shown.expect }),
			});
			const body = (await res.json().catch(() => null)) as { code?: string; error?: string; stillOff?: unknown } | null;
			// Hosting is asked only for a refusal whose sentence can name support.
			const outcome = takeoverOutcome(res.status, body, !res.ok && refusalNamesSupport(body?.code) ? await isHosted() : false);
			if (outcome.kind === 'taken_over') { ondone(outcome.stillOff); return; }
			if (outcome.kind === 'changed') {
				// The line says the new state is shown below, so it goes up only once it is.
				changedLine = '';
				if (await load() && preview !== null) {
					changedLine = outcome.text;
					// A step's note counts too: a known connection that changed hands changes the step. A step
					// whose target is set only when it runs has no note; whether it is one is in the step itself
					// (`targetAtRun`), and its sentence names no person, so no hand can change it.
					changes = stampChanges(shown, preview, (q, i) => `${JSON.stringify(q.steps[i])}\n${stepConnectionNote(q, q.steps[i]!) ?? ''}`);
					toMark = true;
				}
				return;
			}
			error = outcome.text;
			if (body?.code === 'nothing_to_take_over') onstale();
		} catch {
			error = t('common.save_failed');
		} finally {
			sending = false;
			// The confirm was turned off, or the content it sat in was replaced: focus goes back to the
			// head of the dialog rather than to the page behind it, unless something outside the
			// dialog took it meanwhile, such as an overlay above it. After a change it goes to the
			// first changed part, brought into sight below the line that says why, which stays in
			// sight while it is short and the frame is high enough (DialogStatusLine).
			await tick();
			if (dialog?.isConnected === true && keyIsOurs()) {
				const mark = toMark ? dialog.querySelector<HTMLElement>('[data-stamp-changed]') : null;
				(mark ?? heading)?.focus({ preventScroll: mark !== null });
				if (mark) bringIntoReview(dialog, mark);
			}
		}
	}
</script>

<svelte:window onkeydown={(e) => { if (!keyIsOurs()) return; if (e.key === 'Escape') onclose(); else trapTab(e); }} />
<div
	bind:this={dialog}
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="workflow-takeover-title"
	aria-busy={sending || loading}
	tabindex="-1"
	data-testid="takeover-dialog"
>
	<div class="w-full max-w-2xl rounded-[var(--radius-md)] border border-border bg-bg p-5 shadow-lg max-h-[85vh] overflow-y-auto">
		<h2 id="workflow-takeover-title" bind:this={heading} tabindex="-1" class="text-sm font-medium mb-1 break-words"><MarkedLine text={tf('workflow_library.takeover.title', { name: shownValue(preview?.workflow.name ?? workflow.name) })} mono={false} /></h2>
		{#if changedLine}
			<DialogStatusLine text={changedLine} testid="takeover-changed" bind:el={changedEl} />
		{/if}
		{#if error}
			<p bind:this={errorLine} role="alert" data-testid="takeover-error" class="rounded-[var(--radius-sm)] bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger mb-3">{error}</p>
		{/if}

		{#if loading}
			<p class="text-text-subtle text-sm">{t('common.loading')}</p>
		{:else if preview}
			{@const p = preview}
			<ul class="mb-2 space-y-0.5 text-xs" data-takeover-part="marks">
				{#each p.marks as m, i (i)}
					<li data-testid="takeover-mark" class="break-words"><MarkedLine text={markLine(m)} /></li>
				{/each}
			</ul>
			<p class="text-xs text-text-subtle mb-3" data-takeover-part="intro">{t('workflow_library.takeover.intro')}</p>
			<div data-takeover-part="stamp">
				<StampPreviewBody preview={p} stepNote={(i) => stepConnectionNote(p, p.steps[i]!)} {changes} />
			</div>
			<div class="mt-3 space-y-2 text-xs">
				{#each workflowTakeoverLines(p) as line, i (i)}
					<p data-takeover-part={line.kind} class="break-words"><MarkedLine text={line.text} group={folds} /></p>
				{/each}
			</div>
		{/if}

		<div data-dialog-foot class={DIALOG_FOOT_CLASS}>
			<button
				onclick={onclose}
				class="min-h-11 md:min-h-0 rounded-[var(--radius-sm)] border border-border bg-bg-muted px-3 py-1 text-xs text-text-muted hover:bg-bg transition-colors"
			>{t('workflow_library.cancel')}</button>
			<button
				data-testid="takeover-confirm"
				onclick={confirm}
				disabled={preview === null || loading || sending}
				class="min-h-11 md:min-h-0 flex items-center gap-1 rounded-[var(--radius-sm)] border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>{t('workflow_library.takeover.confirm')}</button>
		</div>
	</div>
</div>
