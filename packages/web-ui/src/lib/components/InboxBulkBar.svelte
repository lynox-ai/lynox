<script lang="ts">
	import { t } from '../i18n.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import {
		applyBulkAction,
		clearBulkSelection,
		getSelectedForBulk,
		getSelectionCount,
		type BulkAction,
	} from '../stores/inbox.svelte.js';

	interface Props {
		/** Fires after a bulk action is applied so the parent can show the UNDO toast. */
		onApplied?: (bulkId: string, action: BulkAction, count: number) => void;
		/** Opens a chat with the selected items loaded as context (bulk escalate). */
		onEscalate?: (ids: string[]) => void;
	}

	const { onApplied, onEscalate }: Props = $props();
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
		<div class="flex flex-wrap items-center gap-1.5">
			{#if onEscalate}
				<button
					type="button"
					class="flex items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] border border-accent bg-accent px-2.5 py-1 pointer-coarse:min-h-[44px] text-[11px] text-accent-fg hover:opacity-90"
					onclick={() => onEscalate?.(Array.from(getSelectedForBulk()))}
				>
					<Icon name="chat" size="xs" />
					{t('inbox.bulk_escalate').replace('{count}', String(count))}
				</button>
			{/if}
			<button
				type="button"
				class="whitespace-nowrap rounded-[var(--radius-sm)] border border-border bg-bg px-2.5 py-1 pointer-coarse:min-h-[44px] text-[11px] text-text-muted hover:text-text"
				onclick={() => void run('archived')}
			>{t('inbox.bulk_archive')}</button>
			<button
				type="button"
				class="whitespace-nowrap rounded-[var(--radius-sm)] border border-border bg-bg px-2.5 py-1 pointer-coarse:min-h-[44px] text-[11px] text-text-muted hover:text-text"
				onclick={() => void run('snoozed')}
				title={t('inbox.bulk_snooze_tomorrow_hint')}
			>{t('inbox.bulk_snooze_tomorrow')}</button>
			<button
				type="button"
				class="rounded-[var(--radius-sm)] px-2 py-1 pointer-coarse:min-h-[44px] text-[11px] text-text-subtle hover:text-text"
				onclick={() => clearBulkSelection()}
				aria-label={t('inbox.bulk_clear')}
			>×</button>
		</div>
	</div>
{/if}
