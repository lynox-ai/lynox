<script lang="ts">
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import StampPreviewBody from './StampPreviewBody.svelte';
	import { visible } from '../utils/workflow-stamp.js';
	import {
		markLine, parseWorkflowTakeoverPreview, stepConnectionNote, takeoverOutcome, takeoverRefusalText, workflowTakeoverLines,
		type WorkflowTakeoverPreview,
	} from '../utils/workflow-takeover.js';

	// The owner's takeover of a workflow whose person's access ended: what it covers and stamps, read
	// from the engine's preview, and the one act that takes it over against the digest of exactly
	// what was shown.
	let { workflow, onclose, ondone }: {
		workflow: { id: string; name: string };
		onclose: () => void;
		ondone: (stillOff: unknown) => void;
	} = $props();

	let preview = $state<WorkflowTakeoverPreview | null>(null);
	let loading = $state(true);
	let sending = $state(false);
	let error = $state('');
	// Set once a takeover was refused because something shown moved, and the new state is shown.
	let changedLine = $state(false);
	let generation = 0;

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
		error = '';
		try {
			const res = await fetch(`${getApiBase()}/workflows/${encodeURIComponent(workflow.id)}/takeover-preview`);
			const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
			if (mine !== generation) return false;
			if (res.ok && body !== null && typeof body['refusal'] === 'string') {
				error = takeoverRefusalText(body['refusal'], false, typeof body['message'] === 'string' ? body['message'] : t('common.load_failed'));
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
		try {
			const res = await fetch(`${getApiBase()}/workflows/${encodeURIComponent(workflow.id)}/takeover`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ expect: shown.expect }),
			});
			const body = (await res.json().catch(() => null)) as { code?: string; error?: string; stillOff?: unknown } | null;
			const outcome = takeoverOutcome(res.status, body, res.status === 503 ? await isHosted() : false);
			if (outcome.kind === 'taken_over') { ondone(outcome.stillOff); return; }
			if (outcome.kind === 'changed') {
				// The line says the new state is shown below, so it goes up only once it is.
				changedLine = false;
				if (await load()) changedLine = true;
				return;
			}
			error = outcome.text;
		} catch {
			error = t('common.save_failed');
		} finally {
			sending = false;
		}
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
	role="dialog"
	aria-modal="true"
	aria-label={t('workflow_library.takeover.title')}
	data-testid="takeover-dialog"
>
	<div class="w-full max-w-2xl rounded-[var(--radius-md)] border border-border bg-bg p-5 shadow-lg max-h-[85vh] overflow-y-auto">
		<h2 class="text-sm font-medium mb-1 break-words">{t('workflow_library.takeover.title')}: {visible(workflow.name)}</h2>
		{#if changedLine}
			<p role="status" data-testid="takeover-changed" class="rounded-[var(--radius-sm)] border border-warning/30 bg-warning/10 px-3 py-2 text-xs mb-3">{t('workflow_library.takeover.refused.changed')}</p>
		{/if}
		{#if error}
			<p data-testid="takeover-error" class="rounded-[var(--radius-sm)] bg-danger/10 border border-danger/20 px-3 py-2 text-xs text-danger mb-3">{error}</p>
		{/if}

		{#if loading}
			<p class="text-text-subtle text-sm">{t('common.loading')}</p>
		{:else if preview}
			{@const p = preview}
			<ul class="mb-2 space-y-0.5 text-xs" data-takeover-part="marks">
				{#each p.marks as m, i (i)}
					<li data-testid="takeover-mark" class="break-words">{markLine(m)}</li>
				{/each}
			</ul>
			<p class="text-xs text-text-subtle mb-3" data-takeover-part="intro">{t('workflow_library.takeover.intro')}</p>
			<div data-takeover-part="stamp">
				<StampPreviewBody preview={p} stepNote={(i) => stepConnectionNote(p, p.steps[i]!)} />
			</div>
			<div class="mt-3 space-y-2 text-xs">
				{#each workflowTakeoverLines(p) as line, i (i)}
					<p data-takeover-part={line.kind} class="break-words">{line.text}</p>
				{/each}
			</div>
		{/if}

		<div class="flex items-center justify-end gap-2 mt-5">
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
