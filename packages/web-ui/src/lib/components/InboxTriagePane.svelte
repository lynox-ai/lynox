<script lang="ts">
	import { t, getLocale } from '../i18n.svelte.js';
	import {
		closeItem,
		getInboxItems,
		getSelectedFull,
		getSelectedItemId,
		getSelectedThread,
		isSelectedLoading,
		openItem,
		setItemAction,
		setItemSnooze,
		type InboxItem,
		type SnoozePreset,
	} from '../stores/inbox.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { inboxHeadline } from '../utils/inbox-headline.js';
	import InboxThreadHistory from './InboxThreadHistory.svelte';
	import MarkdownRenderer from './MarkdownRenderer.svelte';

	interface Props {
		onReply?: (item: InboxItem) => void;
		onActionApplied?: () => void;
		onExit: () => void;
		// Bindable so the parent can open the snooze menu via the `s` keyboard
		// shortcut (the menu lives inside this pane, but the keyboard handler
		// lives in InboxView).
		snoozeMenuOpen?: boolean;
	}

	let {
		onReply,
		onActionApplied,
		onExit,
		snoozeMenuOpen = $bindable(false),
	}: Props = $props();

	// One source of truth for the actionable queue — both the auto-open effect
	// and archive/snooze step-forward read it.
	const queue = $derived(getInboxItems('requires_user').filter((i) => !i.userAction));

	$effect(() => {
		if (queue.length === 0) return;
		if (getSelectedItemId() === null) {
			void openItem(queue[0]!.id);
		}
	});
	const full = $derived(getSelectedFull());
	const thread = $derived(getSelectedThread());
	const loading = $derived(isSelectedLoading());

	const currentIdx = $derived.by((): number => {
		const id = getSelectedItemId();
		if (id === null) return -1;
		return queue.findIndex((i) => i.id === id);
	});
	const total = $derived(queue.length);
	const positionLabel = $derived(
		currentIdx >= 0
			? t('inbox.triage_position').replace('{pos}', String(currentIdx + 1)).replace('{total}', String(total))
			: total > 0 ? `0 / ${total}` : '0 / 0',
	);

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

	async function next(): Promise<void> {
		if (queue.length === 0) return;
		const idx = currentIdx === -1 ? 0 : Math.min(queue.length - 1, currentIdx + 1);
		const target = queue[idx];
		if (target) await openItem(target.id);
	}

	async function prev(): Promise<void> {
		if (queue.length === 0) return;
		const idx = currentIdx === -1 ? 0 : Math.max(0, currentIdx - 1);
		const target = queue[idx];
		if (target) await openItem(target.id);
	}

	async function archive(): Promise<void> {
		if (!full) return;
		const beforeIdx = currentIdx;
		await setItemAction(full.item.id, 'archived');
		onActionApplied?.();
		// Step to the next sibling at the same position so triage flows on.
		if (queue.length === 0) {
			closeItem();
			addToast(t('inbox.triage_done'), 'success');
			return;
		}
		const nextItem = queue[Math.min(beforeIdx, queue.length - 1)];
		if (nextItem) await openItem(nextItem.id);
	}

	// Toggles whether the next preset-pick fires a reminder notification at
	// resurface time or just resurfaces silently. Set by the "📌 Erinner mich"
	// button; reset to false after each snooze fires.
	let notifyOnUnsnoozeOnNext = $state(false);

	async function snooze(preset: SnoozePreset): Promise<void> {
		if (!full) return;
		const beforeIdx = currentIdx;
		snoozeMenuOpen = false;
		const notify = notifyOnUnsnoozeOnNext;
		notifyOnUnsnoozeOnNext = false;
		await setItemSnooze(full.item.id, null, null, true, preset, notify);
		onActionApplied?.();
		if (queue.length === 0) {
			closeItem();
			addToast(t('inbox.triage_done'), 'success');
			return;
		}
		const nextItem = queue[Math.min(beforeIdx, queue.length - 1)];
		if (nextItem) await openItem(nextItem.id);
	}

	function openReminderPicker(): void {
		notifyOnUnsnoozeOnNext = true;
		snoozeMenuOpen = true;
	}

	const snoozePresets: ReadonlyArray<{ label: string; preset: SnoozePreset }> = $derived([
		{ label: t('inbox.snooze_today'), preset: 'later_today' as const },
		{ label: t('inbox.snooze_tomorrow'), preset: 'tomorrow_morning' as const },
		{ label: t('inbox.snooze_monday_9'), preset: 'monday_9am' as const },
		{ label: t('inbox.snooze_week'), preset: 'next_week' as const },
	]);
</script>

<div class="flex h-full flex-col bg-bg">
	<!-- Triage navigation header: position + prev/next + exit. Sticky so it
		stays in view when the body scrolls past viewport height. -->
	<header class="border-b border-border bg-bg-subtle/40 px-4 py-2 flex items-center gap-2">
		<button
			type="button"
			onclick={() => onExit()}
			class="text-[11px] text-text-subtle hover:text-text px-2 py-1.5 rounded-[var(--radius-sm)] hover:bg-bg-muted"
			aria-label={t('inbox.triage_exit')}
		>
			← {t('inbox.triage_exit')}
		</button>
		<span class="ml-auto text-[11px] font-mono text-text-subtle tabular-nums">
			{positionLabel}
		</span>
		<button
			type="button"
			onclick={() => void prev()}
			disabled={currentIdx <= 0}
			class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5 text-[11px] text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
			aria-label={t('inbox.triage_prev')}
		>↑</button>
		<button
			type="button"
			onclick={() => void next()}
			disabled={currentIdx >= total - 1 || total === 0}
			class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5 text-[11px] text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
			aria-label={t('inbox.triage_next')}
		>↓</button>
	</header>

	{#if total === 0}
		<div class="flex-1 flex items-center justify-center p-8 text-center">
			<p class="text-sm text-text-subtle">{t('inbox.triage_done')}</p>
		</div>
	{:else if loading && !full}
		<div class="flex-1 p-6 space-y-3" aria-busy="true">
			<div class="h-6 w-2/3 animate-pulse rounded bg-bg-subtle"></div>
			<div class="h-4 w-1/2 animate-pulse rounded bg-bg-subtle"></div>
			<div class="mt-6 space-y-2">
				<div class="h-3 w-full animate-pulse rounded bg-bg-subtle"></div>
				<div class="h-3 w-11/12 animate-pulse rounded bg-bg-subtle"></div>
				<div class="h-3 w-10/12 animate-pulse rounded bg-bg-subtle"></div>
			</div>
		</div>
	{:else if full}
		<!-- Wider max-width than panel mode so the focused mail breathes. -->
		<div class="flex-1 overflow-y-auto">
			<div class="mx-auto max-w-[780px] px-6 py-6">
				<h2 class="text-xl sm:text-2xl font-light tracking-tight text-text leading-tight">
					{inboxHeadline(full.item)}
				</h2>
				<div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px] text-text-subtle">
					<span class="text-text-muted truncate max-w-full">
						{full.item.fromName || full.item.fromAddress}
						{#if full.item.fromName}
							<span class="text-text-subtle">&lt;{full.item.fromAddress}&gt;</span>
						{/if}
					</span>
					<span class="whitespace-nowrap">{dateFormat(full.item.mailDate ?? full.item.classifiedAt)}</span>
				</div>

				<div class="mt-6">
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
				</div>
			</div>
		</div>

		<!-- Sticky action bar at bottom — primary triage decisions. -->
		<footer class="border-t border-border bg-bg-subtle/40 px-4 py-2.5 flex flex-wrap items-center gap-1.5">
			<button
				type="button"
				onclick={() => onReply?.(full.item)}
				class="rounded-[var(--radius-sm)] border border-accent bg-accent text-accent-text px-3 py-1.5 text-[12px] hover:opacity-90"
			>
				↩ {t('inbox.action_reply')}
			</button>
			<button
				type="button"
				onclick={() => void archive()}
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[12px] text-text-muted hover:text-text"
			>
				{t('inbox.action_archive')}
			</button>
			<button
				type="button"
				onclick={openReminderPicker}
				aria-label={t('inbox.action_remind_me')}
				class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[12px] text-text-muted hover:text-text"
			>📌 {t('inbox.action_remind_me')}</button>
			<div class="relative">
				<button
					type="button"
					onclick={() => { notifyOnUnsnoozeOnNext = false; snoozeMenuOpen = !snoozeMenuOpen; }}
					aria-expanded={snoozeMenuOpen}
					aria-haspopup="menu"
					class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[12px] text-text-muted hover:text-text"
				>{t('inbox.action_snooze')}</button>
				{#if snoozeMenuOpen}
					<ul
						role="menu"
						class="absolute bottom-full left-0 mb-1 z-10 min-w-[180px] rounded-[var(--radius-md)] border border-border bg-bg shadow-lg overflow-hidden"
					>
						{#each snoozePresets as p (p.preset)}
							<li role="none">
								<button
									type="button"
									role="menuitem"
									class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text"
									onclick={() => void snooze(p.preset)}
								>{p.label}</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<span class="ml-auto text-[10px] font-mono text-text-subtle hidden sm:inline">
				j/k · r · a · s · t exit
			</span>
		</footer>
	{/if}
</div>
