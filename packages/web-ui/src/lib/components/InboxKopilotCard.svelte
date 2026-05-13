<script lang="ts">
	import { t } from '../i18n.svelte.js';
	import {
		getInboxCounts,
		getInboxItems,
		getSnoozedCount,
		type InboxItem,
	} from '../stores/inbox.svelte.js';
	import { inboxHeadline } from '../utils/inbox-headline.js';
	import { isTouchPrimary } from '../utils/touch-detect.js';

	interface Props {
		/** Fires when the user clicks an item in the Top-3 list. */
		onPickItem?: (item: InboxItem) => void;
		/** Fires when the user clicks "Start triage". */
		onStartTriage?: () => void;
	}

	const { onPickItem, onStartTriage }: Props = $props();
	const touchPrimary = isTouchPrimary();
	const counts = $derived(getInboxCounts());
	const snoozedCount = $derived(getSnoozedCount());

	const needsItems = $derived(getInboxItems('requires_user').filter((i) => !i.userAction));
	const topThree = $derived(needsItems.slice(0, 3));
	const needsCount = $derived(counts.requires_user);
	const draftsCount = $derived(counts.draft_ready);
	const autoCount = $derived(counts.auto_handled);

	const summary = $derived.by((): string => {
		if (needsCount === 0) return t('inbox.kopilot_summary_zero');
		const key = needsCount === 1 ? 'inbox.kopilot_summary_one' : 'inbox.kopilot_summary_many';
		return t(key).replace('{count}', String(needsCount));
	});

	function senderLabel(item: InboxItem): string {
		return item.fromName || item.fromAddress || '—';
	}
</script>

<div class="flex h-full items-center justify-center p-6 sm:p-10 overflow-y-auto">
	<div class="w-full max-w-[560px] rounded-[var(--radius-md)] border border-border bg-bg-subtle/50 p-6 sm:p-8">
		<h2 class="text-lg font-light tracking-tight text-text">{summary}</h2>

		{#if draftsCount > 0 || autoCount > 0 || snoozedCount > 0}
			<div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-text-subtle">
				{#if draftsCount > 0}
					<span>{t('inbox.kopilot_drafts_ready').replace('{count}', String(draftsCount))}</span>
				{/if}
				{#if autoCount > 0}
					<span aria-hidden="true">·</span>
					<span>{t('inbox.kopilot_auto_handled').replace('{count}', String(autoCount))}</span>
				{/if}
			</div>
		{/if}

		{#if topThree.length > 0}
			<div class="mt-6">
				<p class="text-[11px] font-mono uppercase tracking-wider text-text-subtle mb-2">
					{t('inbox.kopilot_top_heading')}
				</p>
				<ul class="space-y-1.5">
					{#each topThree as item (item.id)}
						<li>
							<button
								type="button"
								class="group w-full text-left rounded-[var(--radius-sm)] border border-transparent bg-bg/50 hover:bg-bg hover:border-border px-3 py-2 transition-colors"
								onclick={() => onPickItem?.(item)}
							>
								<div class="flex items-baseline justify-between gap-2 mb-0.5">
									<span class="text-[11px] text-text-subtle truncate">{senderLabel(item)}</span>
									<span class="shrink-0 text-text-subtle group-hover:text-text-muted text-[11px]" aria-hidden="true">→</span>
								</div>
								<p class="text-sm text-text leading-snug truncate">{inboxHeadline(item)}</p>
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if needsCount > 0}
			<div class="mt-6 flex flex-wrap items-center gap-2">
				<button
					type="button"
					onclick={() => onStartTriage?.()}
					class="rounded-[var(--radius-sm)] border border-accent bg-accent text-accent-text px-4 py-2 text-[12px] hover:opacity-90"
				>
					{t('inbox.kopilot_start_triage')}
				</button>
				<span class="text-[11px] text-text-subtle">{t('inbox.kopilot_pick_hint')}</span>
			</div>
		{/if}

		{#if !touchPrimary}
			<p class="mt-6 pt-4 border-t border-border/60 text-[11px] text-text-subtle font-mono leading-relaxed">
				{t('inbox.kopilot_keys_hint')}
			</p>
		{/if}
	</div>
</div>
