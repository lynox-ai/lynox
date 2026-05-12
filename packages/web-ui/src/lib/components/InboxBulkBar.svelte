<script lang="ts">
	import { t } from '../i18n.svelte.js';
	import {
		applyBulkAction,
		clearBulkSelection,
		getSelectionCount,
		type BulkAction,
	} from '../stores/inbox.svelte.js';

	interface Props {
		/** Fires after a bulk action is applied so the parent can show the UNDO toast. */
		onApplied?: (bulkId: string, action: BulkAction, count: number) => void;
	}

	const { onApplied }: Props = $props();
	const count = $derived(getSelectionCount());

	async function run(action: BulkAction): Promise<void> {
		const result = await applyBulkAction(action);
		if (result !== null) onApplied?.(result.bulkId, action, result.itemCount);
	}
</script>

{#if count > 0}
	<div
		class="mb-3 flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-accent bg-accent/5 px-3 py-2 text-[12px]"
		role="toolbar"
		aria-label={t('inbox.bulk_selected').replace('{count}', String(count))}
	>
		<span class="text-text-muted">
			{t('inbox.bulk_selected').replace('{count}', String(count))}
		</span>
		<div class="flex items-center gap-1.5">
			<button
				type="button"
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-muted hover:text-text"
				onclick={() => void run('archived')}
			>{t('inbox.bulk_archive')}</button>
			<button
				type="button"
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-muted hover:text-text"
				onclick={() => void run('snoozed')}
			>{t('inbox.bulk_snooze_tomorrow')}</button>
			<button
				type="button"
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-muted hover:text-text"
				onclick={() => void run('unhandled')}
			>{t('inbox.bulk_mark_unhandled')}</button>
			<button
				type="button"
				class="rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-text-subtle hover:text-text"
				onclick={() => clearBulkSelection()}
				aria-label={t('inbox.bulk_clear')}
			>×</button>
		</div>
	</div>
{/if}
