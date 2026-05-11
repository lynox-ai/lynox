<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { t, getLocale } from '../i18n.svelte.js';
	import {
		getInboxCounts,
		getInboxItems,
		getLastAction,
		isInboxAvailable,
		isLoading,
		loadInboxCounts,
		loadInboxItems,
		setItemAction,
		setItemSnooze,
		startColdStartPolling,
		startInboxVisibilityRefresh,
		undoLastAction,
		type InboxBucket,
		type InboxItem,
	} from '../stores/inbox.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { accountShortLabel } from '../utils/account-label.js';
	import { keyToInboxAction, shouldIgnoreShortcut } from '../utils/inbox-shortcuts.js';
	import { isTouchPrimary } from '../utils/touch-detect.js';
	import ColdStartBanner from './ColdStartBanner.svelte';
	import KeyboardShortcutsHelp from './KeyboardShortcutsHelp.svelte';

	let zone = $state<InboxBucket>('requires_user');
	let openSnoozeFor = $state<string | null>(null);
	let selectedItemId = $state<string | null>(null);
	let helpOpen = $state(false);
	// Gate items-fetch on counts-loaded so the $effect doesn't race onMount's
	// initial load (without this the bucket gets fetched twice on mount).
	let countsLoaded = $state(false);
	const touchPrimary = isTouchPrimary();

	let cleanupVisibility: (() => void) | undefined;
	let cleanupColdStart: (() => void) | undefined;
	let cleanupKeyHandler: (() => void) | undefined;

	onMount(async () => {
		await loadInboxCounts();
		countsLoaded = true;
		// Polling starts unconditionally so a late flag-flip still surfaces the
		// banner; the endpoint returns 503 + empty snapshot while disabled.
		cleanupColdStart = startColdStartPolling();
		cleanupVisibility = startInboxVisibilityRefresh();
		// Skip the listener entirely on touch-primary devices — the help
		// affordance is keyboard-only and the events would be dead weight.
		if (!touchPrimary && typeof window !== 'undefined') {
			window.addEventListener('keydown', onKeyDown);
			cleanupKeyHandler = () => window.removeEventListener('keydown', onKeyDown);
		}
	});

	onDestroy(() => {
		cleanupVisibility?.();
		cleanupColdStart?.();
		cleanupKeyHandler?.();
	});

	$effect(() => {
		if (!countsLoaded) return;
		if (zone && isInboxAvailable()) {
			void loadInboxItems(zone);
			// Selection only makes sense for the Needs-You actionable list.
			if (zone !== 'requires_user') selectedItemId = null;
			openSnoozeFor = null;
		}
	});

	function visibleItems(): InboxItem[] {
		return getInboxItems(zone).filter((i) => !i.userAction);
	}

	async function moveSelection(delta: 1 | -1): Promise<void> {
		const items = visibleItems();
		if (items.length === 0) {
			selectedItemId = null;
			return;
		}
		const currentIdx = selectedItemId === null
			? -1
			: items.findIndex((i) => i.id === selectedItemId);
		const nextIdx = currentIdx === -1
			? (delta === 1 ? 0 : items.length - 1)
			: Math.max(0, Math.min(items.length - 1, currentIdx + delta));
		// Capture the resolved id BEFORE awaiting tick so a rapid second J/K
		// can't redirect scrollIntoView to a stale target.
		const targetId = items[nextIdx]?.id ?? null;
		selectedItemId = targetId;
		if (targetId === null) return;
		await tick();
		if (typeof document === 'undefined') return;
		// CSS.escape: the id comes from the API and is well-typed today, but
		// a malformed upstream value containing `"` or `]` would otherwise
		// corrupt the attribute selector. `behavior:'auto'` keeps rapid J/K
		// from stacking smooth-scroll animations.
		document
			.querySelector(`[data-inbox-item-id="${CSS.escape(targetId)}"]`)
			?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
	}

	async function archiveSelected(): Promise<void> {
		const before = visibleItems();
		const idx = selectedItemId === null
			? -1
			: before.findIndex((i) => i.id === selectedItemId);
		if (idx === -1) return;
		const item = before[idx];
		if (!item) return;
		await setItemAction(item.id, 'archived');
		// Step selection to the next sibling (or previous when at end), so
		// J/K can keep rolling through the queue without re-targeting.
		const after = visibleItems();
		selectedItemId = after.length === 0
			? null
			: after[Math.min(idx, after.length - 1)]?.id ?? null;
	}

	function openSnoozeForSelected(): void {
		const item = visibleItems().find((i) => i.id === selectedItemId);
		if (!item) return;
		openSnoozeFor = item.id;
	}

	async function undoOrHint(): Promise<void> {
		if (getLastAction() === null) {
			addToast(t('inbox.undo_empty'), 'info');
			return;
		}
		await undoLastAction();
	}

	function closeOverlays(): void {
		if (helpOpen) { helpOpen = false; return; }
		if (openSnoozeFor !== null) { openSnoozeFor = null; return; }
	}

	function onKeyDown(event: KeyboardEvent): void {
		// Block synthetic keydowns — only real user input can mutate the inbox.
		if (!event.isTrusted) return;
		if (shouldIgnoreShortcut(event.target)) return;
		// Suppress shortcuts in the other zones — the actions are meaningless
		// there. The help overlay (`?`) and `Esc` stay available everywhere.
		const action = keyToInboxAction(event);
		if (!action) return;
		if (action.kind === 'toggle_help') {
			event.preventDefault();
			helpOpen = !helpOpen;
			return;
		}
		if (action.kind === 'close') {
			if (helpOpen || openSnoozeFor !== null) {
				event.preventDefault();
				closeOverlays();
			}
			return;
		}
		if (zone !== 'requires_user') return;
		event.preventDefault();
		switch (action.kind) {
			case 'next': void moveSelection(1); break;
			case 'prev': void moveSelection(-1); break;
			case 'archive': void archiveSelected(); break;
			case 'snooze': openSnoozeForSelected(); break;
			case 'undo': void undoOrHint(); break;
		}
	}

	function dateFormat(iso: string): string {
		const d = new Date(iso);
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		const now = new Date();
		const sameDay = d.toDateString() === now.toDateString();
		return sameDay
			? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
	}

	function channelLabel(c: InboxItem['channel']): string {
		return c === 'whatsapp' ? t('inbox.channel_whatsapp') : t('inbox.channel_email');
	}

	const HOUR_MS = 3_600_000;
	const DAY_MS = 24 * HOUR_MS;
	// $derived so the array + 4 t() lookups only re-run when locale changes,
	// not on every reactive re-eval of the snooze panel parent.
	const snoozePresets = $derived<ReadonlyArray<{ label: string; deltaMs: number }>>([
		{ label: t('inbox.snooze_1h'), deltaMs: HOUR_MS },
		{ label: t('inbox.snooze_today'), deltaMs: 6 * HOUR_MS },
		{ label: t('inbox.snooze_tomorrow'), deltaMs: DAY_MS },
		{ label: t('inbox.snooze_week'), deltaMs: 7 * DAY_MS },
	]);

	async function onArchive(item: InboxItem): Promise<void> {
		await setItemAction(item.id, 'archived');
	}

	async function onSnoozePreset(item: InboxItem, deltaMs: number): Promise<void> {
		const until = new Date(Date.now() + deltaMs);
		await setItemSnooze(item.id, until);
		openSnoozeFor = null;
	}
</script>

<div
	class="p-4 sm:p-6 max-w-3xl mx-auto pb-[max(1rem,env(safe-area-inset-bottom))]"
	role="region"
	aria-label={t('inbox.title')}
	aria-live="polite"
>
	<div class="flex items-center justify-between flex-wrap gap-y-2 mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('inbox.title')}</h1>
		<div class="flex items-center gap-3 flex-wrap">
			<a
				href="/app/inbox/rules"
				class="text-[11px] text-text-subtle hover:text-text-muted font-mono py-1"
			>{t('inbox.rules_link')}</a>
			{#if !touchPrimary}
				<button
					type="button"
					onclick={() => (helpOpen = true)}
					class="text-[11px] text-text-subtle hover:text-text-muted font-mono py-1"
					aria-label={t('inbox.shortcuts_title')}
				>{t('inbox.shortcuts_hint')}</button>
			{/if}
		</div>
	</div>

	{#if !isInboxAvailable()}
		<div class="rounded-[var(--radius-md)] bg-bg-subtle border border-border px-4 py-6 text-sm text-text-muted">
			{t('inbox.unavailable')}
		</div>
	{:else}
		{@const counts = getInboxCounts()}
		<ColdStartBanner />
		<div
			class="flex gap-1 mb-4 overflow-x-auto scrollbar-none -mx-4 px-4 py-1 sm:mx-0 sm:px-0"
			role="tablist"
			aria-label={t('inbox.title')}
		>
			<button
				role="tab"
				aria-selected={zone === 'requires_user'}
				onclick={() => (zone = 'requires_user')}
				class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'requires_user' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
			>
				<span>{t('inbox.zone_needs_you')}</span>
				{#if counts.requires_user > 0}
					<span class="rounded-full bg-accent/15 text-accent-text px-1.5 text-[10px] font-mono">{counts.requires_user}</span>
				{/if}
			</button>
			<button
				role="tab"
				aria-selected={zone === 'draft_ready'}
				onclick={() => (zone = 'draft_ready')}
				class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'draft_ready' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
			>
				<span>{t('inbox.zone_drafted')}</span>
				{#if counts.draft_ready > 0}
					<span class="rounded-full bg-bg-muted text-text-muted px-1.5 text-[10px] font-mono">{counts.draft_ready}</span>
				{/if}
			</button>
			<button
				role="tab"
				aria-selected={zone === 'auto_handled'}
				onclick={() => (zone = 'auto_handled')}
				class="rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'auto_handled' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
			>
				<span>{t('inbox.zone_handled')}</span>
				{#if counts.auto_handled > 0}
					<span class="rounded-full bg-bg-muted text-text-muted px-1.5 text-[10px] font-mono">{counts.auto_handled}</span>
				{/if}
			</button>
		</div>

		{#if isLoading(zone)}
			<p class="text-text-subtle text-sm">{t('inbox.loading')}</p>
		{:else}
			{@const items = getInboxItems(zone)}
			{#if items.length === 0}
				<p class="text-text-subtle text-sm">
					{#if zone === 'requires_user'}{t('inbox.empty_needs_you')}
					{:else if zone === 'draft_ready'}{t('inbox.empty_drafted')}
					{:else}{t('inbox.empty_handled')}
					{/if}
				</p>
			{:else}
				<ul class="space-y-2" role="list">
					{#each items as item (item.id)}
						<li
							role="listitem"
							data-inbox-item-id={item.id}
							aria-label={`${zone === 'requires_user' ? t('inbox.zone_needs_you') : ''}: ${item.reasonDe}`}
							aria-current={zone === 'requires_user' && selectedItemId === item.id ? 'true' : undefined}
							class="rounded-[var(--radius-md)] border bg-bg-subtle px-4 py-3 transition-colors {zone === 'requires_user' && selectedItemId === item.id ? 'border-accent' : 'border-border'}"
						>
							<div class="flex items-start justify-between gap-3">
								<div class="min-w-0 flex-1">
									<div class="flex items-center gap-2 text-[11px] text-text-subtle mb-1">
										<span title={item.accountId}>📬 {accountShortLabel(item.accountId)}</span>
										<span aria-hidden="true">·</span>
										<span>{channelLabel(item.channel)}</span>
										<span aria-hidden="true">·</span>
										<span>{dateFormat(item.classifiedAt)}</span>
									</div>
									<p class="text-sm text-text leading-relaxed">{item.reasonDe}</p>
									{#if item.classifierVersion === 'sensitive-prefilter'}
										<p class="text-[11px] text-warning mt-1" aria-label="sensitive content">
											⚠ {t('inbox.action_reply')}
										</p>
									{/if}
								</div>
								{#if zone === 'requires_user' && !item.userAction}
									<div class="flex items-center gap-1 shrink-0">
										<button
											onclick={() => void onArchive(item)}
											class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
											aria-label={t('inbox.action_archive')}
										>{t('inbox.action_archive')}</button>
										<button
											onclick={() => (openSnoozeFor = openSnoozeFor === item.id ? null : item.id)}
											aria-expanded={openSnoozeFor === item.id}
											class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
										>{t('inbox.action_snooze')}</button>
									</div>
								{/if}
							</div>
							{#if openSnoozeFor === item.id}
								<div class="mt-2 flex flex-wrap gap-1.5 pl-1">
									{#each snoozePresets as preset (preset.label)}
										<button
											onclick={() => void onSnoozePreset(item, preset.deltaMs)}
											class="rounded-[var(--radius-sm)] bg-bg-muted text-text-muted hover:text-text px-3 py-1.5 text-[11px] min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
										>{preset.label}</button>
									{/each}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	{/if}
</div>

<KeyboardShortcutsHelp open={helpOpen} onClose={() => (helpOpen = false)} />

