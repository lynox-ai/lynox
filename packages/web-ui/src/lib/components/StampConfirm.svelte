<script lang="ts">
	// The owner's stamp of one schedule (641 4b (ii-a), ii-c-min). Shows the schedule from the
	// stamp preview, never from the list the view polls, and confirms with the preview's `expect`:
	// what the owner reads is what the engine stamps, or it answers 409 `changed` and this shows the
	// new state for a second look. `mode`: `held` for a schedule waiting for its stamp, `check` for a
	// confirmed one whose connections the owner opened ("Check connections").
	import { getApiBase } from '../config.svelte.js';
	import { t, tf } from '../i18n.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { instructionOf, markHidden, watchOf } from '../utils/trigger-consent.js';
	import { confirmable, connectionsSentence, hiddenIn, hiddenNote, hidesText, paramsOf, shownAs, type StampPreview } from '../utils/stamp-confirm.js';

	interface Props {
		id: string;
		mode: 'held' | 'check';
		cronText: (cron: string) => string;
		onstamped: () => void;
		onclose?: () => void;
	}
	let { id, mode, cronText, onstamped, onclose }: Props = $props();

	let preview = $state<StampPreview | null>(null);
	let failed = $state(false);
	let changed = $state(false);
	let busy = $state(false);
	let note = $state<HTMLElement | null>(null);
	// Answers can overtake each other (a reload after a 409, "Load again"); only the latest counts.
	let request = 0;

	async function load(): Promise<void> {
		const mine = ++request;
		failed = false;
		try {
			const res = await fetch(`${getApiBase()}/tasks/${encodeURIComponent(id)}/stamp-preview`);
			if (!res.ok) throw new Error();
			const answer = (await res.json()) as StampPreview;
			if (mine !== request) return;
			preview = answer;
		} catch {
			if (mine !== request) return;
			preview = null;
			failed = true;
		}
	}

	async function confirm(): Promise<void> {
		const shown = preview;
		if (busy || shown === null || !confirmable(shown)) return;
		busy = true;
		try {
			const res = await fetch(`${getApiBase()}/tasks/${encodeURIComponent(id)}/confirm`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ expect: shown.expect }),
			});
			if (res.ok) {
				addToast(t('triggers.confirmed'), 'success');
				onstamped();
				return;
			}
			const code = res.status === 409 ? ((await res.json().catch(() => ({}))) as { code?: unknown }).code : undefined;
			// Only `changed` asks for another look; every other refusal is final here (a pause
			// since the list loaded answers 409 `paused`, and a new preview would not change it).
			if (code === 'changed') {
				changed = true;
				await load();
				note?.focus();
				return;
			}
			addToast(t('triggers.confirm_failed'), 'error');
		} catch {
			addToast(t('triggers.confirm_failed'), 'error');
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		void id;
		changed = false;
		preview = null;
		void load();
	});

	const watch = $derived(preview?.subject.watch ? watchOf({ watch_config: preview.subject.watch }) : undefined);
	const selector = $derived.by(() => {
		if (!preview?.subject.watch) return null;
		try {
			const s = (JSON.parse(preview.subject.watch) as { selector?: unknown }).selector;
			return typeof s === 'string' && s !== '' ? markHidden(s) : null;
		} catch { return null; }
	});
	const sentence = $derived(preview ? connectionsSentence(preview) : null);
</script>

<div class="mt-2 space-y-1.5 text-xs text-text-muted" data-stamp-confirm={mode}>
	{#if changed}
		<p class="text-warning" role="status" tabindex="-1" bind:this={note} data-stamp-changed>{t('stamp.changed')}</p>
	{/if}
	{#if failed}
		<p data-stamp-failed>{t('stamp.load_failed')}</p>
		<button onclick={() => void load()} class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1 text-xs text-text-muted hover:text-text" data-stamp-reload>{t('takeover.reload')}</button>
	{:else if preview === null}
		<p>{t('common.loading')}</p>
	{:else}
		{@const s = preview.subject}
		{@const as = shownAs(preview)}
		{#if as === 'workflow'}
			<div data-stamp-workflow>
				<span class="font-medium">{t('stamp.workflow')}:</span> {markHidden(preview.workflow?.name ?? s.pipeline_id ?? '')}
				{#if paramsOf(s.pipeline_params).length > 0}
					<p class="mt-0.5"><span class="font-medium">{t('stamp.params')}:</span> {paramsOf(s.pipeline_params).join(' · ')}</p>
				{/if}
			</div>
		{:else if as === 'watch' && watch}
			<div data-stamp-watch>
				<span class="font-medium">{t('triggers.watch_url')}:</span>
				<p class="mt-0.5 break-words rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5"><span class="font-medium text-text">{watch.host}</span>{watch.rest}</p>
				{#if watch.intervalMinutes}<p class="mt-0.5">{tf('triggers.watch_every', { minutes: String(watch.intervalMinutes) })}</p>{/if}
				{#if selector}<p class="mt-0.5"><span class="font-medium">{t('stamp.watch_selector')}:</span> {selector}</p>{/if}
			</div>
		{:else if as === 'instruction'}
			<div data-stamp-instruction>
				<span class="font-medium">{t('triggers.instruction')}:</span>
				<p class="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">{markHidden(instructionOf({ title: s.title, description: s.description ?? undefined }))}</p>
			</div>
		{/if}
		{#if s.schedule_cron}
			<p data-stamp-schedule><span class="font-medium">{t('stamp.schedule')}:</span> {markHidden(cronText(s.schedule_cron))}</p>
		{/if}
		{#if s.model_tier}
			<p data-stamp-model><span class="font-medium">{t('stamp.model')}:</span> {markHidden(s.model_tier)}</p>
		{/if}
		{#if sentence}
			<p class="text-text" data-stamp-connections>{sentence}</p>
		{:else if mode === 'check'}
			<p data-stamp-none>{t('stamp.none')}</p>
		{/if}
		{#if hidesText(preview)}
			<p class="text-warning" data-stamp-hidden-text={hiddenIn(preview)}>{hiddenNote(hiddenIn(preview) === 'workflow', mode === 'check')}</p>
		{:else if as === 'workflow' && !confirmable(preview)}
			<p class="text-warning" data-stamp-workflow-unconfirmed>{t('stamp.workflow_unconfirmed')}</p>
		{:else if !confirmable(preview)}
			<!-- A watch whose page cannot be read: nothing to agree to, so no button. -->
		{:else if mode === 'held' || sentence !== null}
			<button onclick={() => void confirm()} disabled={busy} aria-label={t('triggers.confirm_label')} title={t('triggers.confirm_label')} class="rounded-[var(--radius-sm)] bg-accent/10 px-3 py-1 text-xs text-accent-text hover:bg-accent/15 disabled:opacity-40" data-stamp-confirm-button>{t('triggers.confirm')}</button>
		{/if}
	{/if}
	{#if mode === 'check' && onclose}
		<button onclick={onclose} class="ml-2 rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1 text-xs text-text-muted hover:text-text" data-stamp-close>{t('stamp.close')}</button>
	{/if}
</div>
