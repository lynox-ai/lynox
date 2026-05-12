<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t } from '../i18n.svelte.js';
	import {
		getRecentBulks,
		pruneRecentBulks,
		undoBulk,
		type InboxBucket,
	} from '../stores/inbox.svelte.js';

	interface Props {
		currentZone: InboxBucket;
	}

	const { currentZone }: Props = $props();
	// $derived re-runs when the store's `recentBulks` reference changes.
	const recent = $derived(getRecentBulks());

	// 60s auto-prune: re-render the toast list every second so the
	// per-toast countdown stays honest. setInterval is cleared on destroy.
	let _tick = $state(0);
	const interval = typeof window !== 'undefined'
		? window.setInterval(() => {
				_tick += 1;
				pruneRecentBulks();
			}, 1000)
		: null;
	onDestroy(() => {
		if (interval !== null) window.clearInterval(interval);
	});

	// Stack max 3 visible toasts; older bulks survive in the menu (not shown here).
	const visible = $derived(recent.slice(0, 3));

	function secondsRemaining(performedAt: number): number {
		// Touch `_tick` so the derived recomputes when the timer fires.
		_tick;
		return Math.max(0, Math.ceil((performedAt + 60_000 - Date.now()) / 1000));
	}
</script>

{#if visible.length > 0}
	<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2" role="region" aria-label="Undo">
		{#each visible as bulk (bulk.bulkId)}
			<div
				class="flex items-center gap-3 rounded-[var(--radius-md)] border border-border bg-bg shadow-lg px-3 py-2 text-[12px]"
				role="status"
			>
				<span class="text-text">
					{t('inbox.bulk_undo_toast').replace('{count}', String(bulk.itemCount))}
				</span>
				<span class="text-text-subtle font-mono">{secondsRemaining(bulk.performedAt)}s</span>
				<button
					type="button"
					class="rounded-[var(--radius-sm)] border border-accent bg-accent/10 px-2 py-1 text-[11px] text-accent-text hover:bg-accent/20"
					onclick={() => void undoBulk(bulk.bulkId, currentZone)}
				>{t('inbox.bulk_undo')}</button>
			</div>
		{/each}
	</div>
{/if}
