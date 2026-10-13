<script lang="ts">
	import { untrack } from 'svelte';
	import { getApiBase } from '../config.svelte.js';
	import { t, tf } from '../i18n.svelte.js';
	import {
		previewPersonErasure,
		erasePerson,
		type PersonErasurePreview,
		type PersonErasureOutcome,
		type PersonErasureResult,
	} from '../api/person-erasure.js';

	// Erasing one person (owner only): preview with the text, the owner ticks the mentions
	// that should go, then one confirm. What is tied to the person always goes and is not
	// selectable. A partial answer is shown as partial, never as done; "not covered" is
	// rendered from the keys the engine answered, so the sentence is exactly its list.

	let { subjectId, onclose, onerased }: {
		subjectId: string;
		onclose: () => void;
		onerased: (id: string) => void;
	} = $props();

	let preview = $state<PersonErasurePreview | null>(null);
	let picked = $state<Set<string>>(new Set());
	let busy = $state(false);
	let notice = $state<PersonErasureOutcome['kind'] | null>(null);
	let result = $state<PersonErasureResult | null>(null);

	const bound = $derived(preview ? [
		...preview.entries.filter(e => e.matchedBy === 'subject'),
		...preview.memories.filter(m => m.matchedBy === 'subject'),
	] : []);
	const mentions = $derived(preview ? [
		...preview.entries.filter(e => e.matchedBy !== 'subject').map(e => ({ ...e, store: 'entry' as const })),
		...preview.memories.filter(m => m.matchedBy !== 'subject').map(m => ({ ...m, store: 'memory' as const })),
	] : []);

	async function load(keepNotice = false) {
		busy = true;
		if (!keepNotice) notice = null;
		const r = await previewPersonErasure(getApiBase(), subjectId);
		busy = false;
		if ('preview' in r) {
			preview = r.preview;
			picked = new Set();
		} else {
			preview = null;
			notice = r.refused.kind;
		}
	}

	function toggle(id: string) {
		const next = new Set(picked);
		if (next.has(id)) next.delete(id); else next.add(id);
		picked = next;
	}

	async function confirm() {
		if (!preview) return;
		busy = true;
		const entryIds = mentions.filter(m => m.store === 'entry' && picked.has(m.id)).map(m => m.id);
		const memoryIds = mentions.filter(m => m.store === 'memory' && picked.has(m.id)).map(m => m.id);
		const outcome = await erasePerson(getApiBase(), { subjectId, plan: preview.plan, entryIds, memoryIds });
		busy = false;
		notice = outcome.kind;
		result = outcome.kind === 'erased' || outcome.kind === 'partial' ? outcome.result : null;
		if (outcome.kind === 'erased') { preview = null; onerased(subjectId); return; }
		// Partial or changed: reload, so what is shown is what is left.
		if (outcome.kind === 'partial' || outcome.kind === 'changed') await load(true);
	}

	$effect(() => { untrack(() => { void load(); }); });
</script>

<div class="mt-3 rounded-[var(--radius-md)] border border-danger/30 bg-danger/10 p-3 text-sm" role="region" aria-label={t('erasure.title')}>
	<div class="flex items-start justify-between gap-2">
		<h3 class="font-medium text-danger">{t('erasure.title')}</h3>
		<button onclick={onclose} class="shrink-0 text-xs text-text-subtle hover:text-text">{t('erasure.cancel')}</button>
	</div>

	{#if notice === 'erased' && result}
		<p class="mt-2" role="status">{tf('erasure.done', { entries: String(result.counts.entries), memories: String(Math.max(result.counts.legacyMemories, result.counts.memoryStubs)) })}</p>
		{#if result.left.entries + result.left.memories > 0}
			<p class="mt-1 text-text-muted">{tf('erasure.left', { n: String(result.left.entries + result.left.memories) })}</p>
		{/if}
		{#if result.left.blocks.length > 0}<p class="mt-1 text-text-muted">{t('erasure.blocks')}</p>{/if}
		{@render notCovered(result.notCovered)}
	{:else}
		{#if notice === 'partial' && result}
			<p class="mt-2 text-danger" role="alert">{tf('erasure.partial', { step: t(`erasure.step.${result.failed ?? 'subject'}`) })}</p>
		{:else if notice && notice !== 'erased'}
			<p class="mt-2 text-danger" role="alert">{t(`erasure.${notice}`)}</p>
		{/if}

		{#if busy && !preview}
			<p class="mt-2 text-text-subtle">{t('common.loading')}</p>
		{:else if preview}
			<p class="mt-2 text-text-muted">{t('erasure.intro')}</p>

			<p class="mt-3 text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('erasure.bound')} ({bound.length})</p>
			{#if bound.length === 0}
				<p class="mt-1 text-xs text-text-subtle">{t('erasure.bound_none')}</p>
			{:else}
				<ul class="mt-1 space-y-1">
					{#each bound as row (row.id)}
						<li class="rounded-[var(--radius-sm)] bg-bg-muted px-2.5 py-1.5 text-xs text-text-muted">{row.text}</li>
					{/each}
				</ul>
			{/if}

			{#if mentions.length > 0}
				<p class="mt-3 text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('erasure.matches')} ({mentions.length})</p>
				<ul class="mt-1 space-y-1">
					{#each mentions as row (row.id)}
						<li>
							<label class="flex items-start gap-2 rounded-[var(--radius-sm)] bg-bg-muted px-2.5 py-1.5 text-xs text-text-muted">
								<input type="checkbox" checked={picked.has(row.id)} onchange={() => toggle(row.id)} class="mt-0.5" />
								<span>{row.text}</span>
							</label>
						</li>
					{/each}
				</ul>
			{/if}

			{#if preview.blocksMentioning.length > 0}
				<p class="mt-3 text-xs text-text-muted">{t('erasure.blocks')}</p>
			{/if}

			{@render notCovered(preview.notCovered)}

			<button onclick={confirm} disabled={busy}
				class="mt-3 w-full rounded-[var(--radius-md)] bg-danger px-3 py-2 text-sm text-white hover:opacity-90 disabled:opacity-50 transition-opacity">
				{busy ? t('common.loading') : notice === 'partial' ? t('erasure.retry') : t('erasure.confirm')}
			</button>
		{:else if notice === 'busy' || notice === 'failed'}
			<button onclick={() => load()} class="mt-2 text-xs underline">{t('erasure.retry')}</button>
		{/if}
	{/if}
</div>

{#snippet notCovered(keys: readonly string[])}
	<p class="mt-3 text-[10px] font-mono uppercase tracking-widest text-text-subtle">{t('erasure.not_covered')}</p>
	<ul class="mt-1 list-disc pl-4 text-xs text-text-muted">
		{#each keys as key (key)}<li>{t(`erasure.nc.${key}`)}</li>{/each}
	</ul>
{/snippet}
