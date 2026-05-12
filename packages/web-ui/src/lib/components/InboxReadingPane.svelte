<script lang="ts">
	import { t, getLocale } from '../i18n.svelte.js';
	import {
		closeItem,
		getSelectedFull,
		getSelectedThread,
		isSelectedLoading,
		refreshSelectedItemBody,
		setItemAction,
		setItemSnooze,
		type InboxItem,
		type SnoozePreset,
	} from '../stores/inbox.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import MarkdownRenderer from './MarkdownRenderer.svelte';
	import InboxThreadHistory from './InboxThreadHistory.svelte';

	interface Props {
		/** Fires when the user clicks "Draft reply" so the parent can open DraftReplyPane. */
		onReply?: (item: InboxItem) => void;
		/** Fires on archive/snooze actions so the parent can refresh the list. */
		onActionApplied?: () => void;
		/** Mobile back-button is shown when true (hidden on three-pane desktop). */
		showBack?: boolean;
	}

	const { onReply, onActionApplied, showBack = false }: Props = $props();

	const full = $derived(getSelectedFull());
	const thread = $derived(getSelectedThread());
	const loading = $derived(isSelectedLoading());
	let snoozeOpen = $state(false);
	let refreshing = $state(false);

	async function onRefreshBody(): Promise<void> {
		if (refreshing) return;
		refreshing = true;
		try {
			const result = await refreshSelectedItemBody();
			if (result.ok) {
				addToast(t('inbox.draft_refresh_ok'), 'success');
				return;
			}
			if (result.reason.kind === 'aborted') return;
			const keyMap: Record<string, string> = {
				unavailable: 'inbox.draft_refresh_unavailable',
				unsupported: 'inbox.draft_refresh_unsupported',
				not_registered: 'inbox.draft_refresh_not_registered',
				empty_body: 'inbox.draft_refresh_empty',
				not_found: 'inbox.draft_refresh_not_found',
				fetch_failed: 'inbox.draft_refresh_failed',
				network: 'inbox.draft_refresh_failed',
			};
			addToast(t(keyMap[result.reason.kind] ?? 'inbox.draft_refresh_failed'), 'info');
		} finally {
			refreshing = false;
		}
	}

	function dateFormat(iso: string | undefined): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		return d.toLocaleDateString(locale, {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	}

	async function onArchive(): Promise<void> {
		if (!full) return;
		await setItemAction(full.item.id, 'archived');
		onActionApplied?.();
		closeItem();
	}

	async function onSnoozePreset(preset: SnoozePreset): Promise<void> {
		if (!full) return;
		snoozeOpen = false;
		await setItemSnooze(full.item.id, null, null, true, preset);
		onActionApplied?.();
		closeItem();
	}

	const snoozePresets: ReadonlyArray<{ label: string; preset: SnoozePreset }> = $derived([
		{ label: t('inbox.snooze_today'), preset: 'later_today' as const },
		{ label: t('inbox.snooze_tomorrow'), preset: 'tomorrow_morning' as const },
		{ label: t('inbox.snooze_monday_9'), preset: 'monday_9am' as const },
		{ label: t('inbox.snooze_week'), preset: 'next_week' as const },
	]);
</script>

{#if !full && !loading}
	<div class="flex h-full items-center justify-center p-8 text-center">
		<p class="text-sm text-text-subtle">{t('inbox.reading_empty_state')}</p>
	</div>
{:else}
	<div class="flex h-full flex-col bg-bg">
		<!-- Mobile-first layout: subject + metadata get full width on mobile (no longer
			competing with 5 action buttons for ~30px of horizontal space). Action row
			stacks below on mobile, sits inline on the right on sm+. -->
		<header class="border-b border-border px-4 py-3">
			<!-- Mobile-only nav strip: ← Zurück on left, × on right. Touch-sized. -->
			{#if showBack || full}
				<div class="mb-2 flex items-center justify-between sm:hidden">
					{#if showBack}
						<button
							type="button"
							class="flex items-center gap-1 text-text-subtle hover:text-text text-sm min-h-[44px] -ml-2 px-2"
							onclick={() => closeItem()}
							aria-label={t('inbox.reading_back')}
						>
							<span aria-hidden="true">←</span>
							<span>{t('inbox.reading_back')}</span>
						</button>
					{:else}
						<span></span>
					{/if}
					{#if full}
						<button
							type="button"
							class="text-text-subtle hover:text-text text-lg leading-none min-h-[44px] min-w-[44px] -mr-2 px-2"
							onclick={() => closeItem()}
							aria-label={t('inbox.reading_close')}
						>×</button>
					{/if}
				</div>
			{/if}

			<!-- Content row: subject + sender/date. Full width on mobile (action group is hidden). -->
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0 flex-1">
					{#if showBack}
						<!-- Desktop-only inline back. Mobile back lives in the nav row above. -->
						<button
							type="button"
							class="hidden sm:inline-block mb-1 text-[11px] text-text-subtle hover:text-text"
							onclick={() => closeItem()}
						>
							← {t('inbox.reading_back')}
						</button>
					{/if}
					{#if loading && !full}
						<div class="space-y-2" aria-busy="true">
							<div class="h-5 w-2/3 animate-pulse rounded bg-bg-subtle"></div>
							<div class="h-4 w-1/2 animate-pulse rounded bg-bg-subtle"></div>
						</div>
					{:else if full}
						<h2 class="truncate text-base sm:text-lg font-semibold text-text" title={full.item.subject}>
							{full.item.subject || '(kein Betreff)'}
						</h2>
						<div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-text-subtle">
							<span class="text-text-muted truncate max-w-full">
								{full.item.fromName || full.item.fromAddress}
								{#if full.item.fromName}
									<span class="text-text-subtle">&lt;{full.item.fromAddress}&gt;</span>
								{/if}
							</span>
							<span class="whitespace-nowrap">{dateFormat(full.item.mailDate ?? full.item.classifiedAt)}</span>
						</div>
					{/if}
				</div>
				<!-- Desktop action group: inline on the right (hidden on mobile) -->
				<div class="hidden sm:flex shrink-0 items-center gap-1.5">
					{#if full}
						<button
							type="button"
							onclick={() => void onRefreshBody()}
							disabled={refreshing}
							title={refreshing ? t('inbox.draft_refresh_in_flight') : t('inbox.draft_refresh_body')}
							aria-label={t('inbox.draft_refresh_body')}
							class="text-text-subtle hover:text-text text-[11px] font-mono p-2 min-h-[36px] disabled:opacity-50 disabled:cursor-not-allowed"
						>{refreshing ? '⟳' : '↻'}</button>
						<button
							type="button"
							class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px]"
							onclick={() => onReply?.(full!.item)}
							aria-label={t('inbox.action_draft_reply')}
						>{t('inbox.action_draft_reply')}</button>
						<button
							type="button"
							class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px]"
							onclick={() => void onArchive()}
							aria-label={t('inbox.action_archive')}
						>{t('inbox.action_archive')}</button>
						<div class="relative">
							<button
								type="button"
								class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px]"
								onclick={() => (snoozeOpen = !snoozeOpen)}
								aria-expanded={snoozeOpen}
								aria-haspopup="menu"
								aria-label={t('inbox.action_snooze')}
							>{t('inbox.action_snooze')}</button>
							{#if snoozeOpen}
								<ul
									role="menu"
									class="absolute right-0 z-10 mt-1 min-w-[180px] rounded-[var(--radius-md)] border border-border bg-bg shadow-lg overflow-hidden"
								>
									{#each snoozePresets as p (p.preset)}
										<li role="none">
											<button
												type="button"
												role="menuitem"
												class="block w-full px-3 py-2 text-left text-[11px] text-text-muted hover:bg-bg-subtle hover:text-text"
												onclick={() => void onSnoozePreset(p.preset)}
											>{p.label}</button>
										</li>
									{/each}
								</ul>
							{/if}
						</div>
					{/if}
					<button
						type="button"
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5 text-[11px] text-text-subtle hover:text-text hover:border-border-hover min-h-[36px]"
						onclick={() => closeItem()}
						aria-label={t('inbox.reading_close')}
					>×</button>
				</div>
			</div>

			<!-- Mobile-only action row: stacks below the subject so the buttons no longer
				starve the content of horizontal space. Touch-sized (min-h-[44px]). -->
			{#if full}
				<div class="mt-3 flex items-center gap-1.5 sm:hidden">
					<button
						type="button"
						onclick={() => void onRefreshBody()}
						disabled={refreshing}
						title={refreshing ? t('inbox.draft_refresh_in_flight') : t('inbox.draft_refresh_body')}
						aria-label={t('inbox.draft_refresh_body')}
						class="text-text-subtle hover:text-text text-base font-mono p-2 min-h-[44px] min-w-[44px] disabled:opacity-50 disabled:cursor-not-allowed"
					>{refreshing ? '⟳' : '↻'}</button>
					<button
						type="button"
						class="flex-1 rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-[12px] text-text-muted hover:text-text hover:border-border-hover min-h-[44px]"
						onclick={() => onReply?.(full!.item)}
						aria-label={t('inbox.action_draft_reply')}
					>{t('inbox.action_draft_reply')}</button>
					<button
						type="button"
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-[12px] text-text-muted hover:text-text hover:border-border-hover min-h-[44px]"
						onclick={() => void onArchive()}
						aria-label={t('inbox.action_archive')}
					>{t('inbox.action_archive')}</button>
					<div class="relative">
						<button
							type="button"
							class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-2 text-[12px] text-text-muted hover:text-text hover:border-border-hover min-h-[44px]"
							onclick={() => (snoozeOpen = !snoozeOpen)}
							aria-expanded={snoozeOpen}
							aria-haspopup="menu"
							aria-label={t('inbox.action_snooze')}
						>{t('inbox.action_snooze')}</button>
						{#if snoozeOpen}
							<ul
								role="menu"
								class="absolute right-0 z-10 mt-1 min-w-[180px] rounded-[var(--radius-md)] border border-border bg-bg shadow-lg overflow-hidden"
							>
								{#each snoozePresets as p (p.preset)}
									<li role="none">
										<button
											type="button"
											role="menuitem"
											class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[44px]"
											onclick={() => void onSnoozePreset(p.preset)}
										>{p.label}</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				</div>
			{/if}
		</header>

		<div class="flex-1 overflow-y-auto px-4 py-4">
			{#if loading && !full}
				<div class="space-y-2" aria-busy="true">
					<div class="h-3 w-full animate-pulse rounded bg-bg-subtle"></div>
					<div class="h-3 w-11/12 animate-pulse rounded bg-bg-subtle"></div>
					<div class="h-3 w-10/12 animate-pulse rounded bg-bg-subtle"></div>
				</div>
			{:else if full}
				{#if full.body.source === 'missing'}
					<p class="rounded-[var(--radius-md)] border border-warning bg-warning-subtle px-3 py-2 text-[12px] text-warning">
						{t('inbox.reading_body_missing')}
					</p>
				{:else}
					<article class="prose prose-sm max-w-none">
						<MarkdownRenderer content={full.body.md} streaming={false} />
					</article>
				{/if}
				{#if thread && (thread.messages.length > 0 || thread.partial)}
					<div class="mt-6">
						<InboxThreadHistory {thread} currentMessageId={full.item.messageId} />
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}
