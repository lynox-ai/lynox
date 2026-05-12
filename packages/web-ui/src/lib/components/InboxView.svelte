<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { t, getLocale } from '../i18n.svelte.js';
	import {
		closeDraftPane,
		closeItem,
		dismissReclassifyBanner,
		getDraftPane,
		getInboxCounts,
		getInboxItems,
		getLastAction,
		getReclassifyBanner,
		getSelectedItemId,
		isComposeOpen,
		isInboxAvailable,
		isLoading,
		isSelectedForBulk,
		loadInboxCounts,
		loadInboxItems,
		onColdStartCompletion,
		openCompose,
		openDraftPane,
		openItem,
		runColdStartBackfillForAllAccounts,
		setItemAction,
		setItemSnooze,
		startColdStartPolling,
		startInboxVisibilityRefresh,
		toggleBulkSelection,
		undoLastAction,
		type InboxBucket,
		type InboxItem,
	} from '../stores/inbox.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { accountShortLabel } from '../utils/account-label.js';
	import { keyToInboxAction, shouldIgnoreShortcut } from '../utils/inbox-shortcuts.js';
	import { isTouchPrimary } from '../utils/touch-detect.js';
	import ColdStartBanner from './ColdStartBanner.svelte';
	import DraftReplyPane from './DraftReplyPane.svelte';
	import InboxBulkBar from './InboxBulkBar.svelte';
	import InboxComposePane from './InboxComposePane.svelte';
	import InboxReadingPane from './InboxReadingPane.svelte';
	import InboxSearchBar from './InboxSearchBar.svelte';
	import InboxUndoToast from './InboxUndoToast.svelte';
	import KeyboardShortcutsHelp from './KeyboardShortcutsHelp.svelte';

	let zone = $state<InboxBucket>('requires_user');
	let openSnoozeFor = $state<string | null>(null);
	let selectedItemId = $state<string | null>(null);
	let searchQuery = $state('');
	let helpOpen = $state(false);
	let coldStartButtonBusy = $state(false);
	// Gate items-fetch on counts-loaded so the $effect doesn't race onMount's
	// initial load (without this the bucket gets fetched twice on mount).
	let countsLoaded = $state(false);
	const touchPrimary = isTouchPrimary();

	let cleanupVisibility: (() => void) | undefined;
	let cleanupColdStart: (() => void) | undefined;
	let cleanupColdStartListener: (() => void) | undefined;
	let cleanupKeyHandler: (() => void) | undefined;

	onMount(async () => {
		await loadInboxCounts();
		countsLoaded = true;
		// Polling starts unconditionally so a late flag-flip still surfaces the
		// banner; the endpoint returns 503 + empty snapshot while disabled.
		cleanupColdStart = startColdStartPolling();
		// Auto-refresh the queue when a cold-start run completes (PRD-3 §"Auto-Refresh
		// on Cold-Start Complete"). Idempotent reloads; brief flicker is acceptable
		// for the "your inbox just filled up" moment.
		cleanupColdStartListener = onColdStartCompletion(() => {
			void loadInboxCounts();
			void loadInboxItems(zone);
		});
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
		cleanupColdStartListener?.();
		cleanupKeyHandler?.();
	});

	$effect(() => {
		if (!countsLoaded) return;
		if (zone && isInboxAvailable()) {
			void loadInboxItems(zone, 50, 0, searchQuery);
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
		if (getDraftPane() !== null) { closeDraftPane(); return; }
		if (openSnoozeFor !== null) { openSnoozeFor = null; return; }
	}

	function openReplyForSelected(): void {
		const item = visibleItems().find((i) => i.id === selectedItemId);
		if (!item) return;
		void openDraftPane(item.id);
	}

	function openReplyFor(item: InboxItem): void {
		void openDraftPane(item.id);
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
			if (helpOpen || getDraftPane() !== null || openSnoozeFor !== null) {
				event.preventDefault();
				closeOverlays();
			}
			return;
		}
		// Suppress directional + bucket-actions while the pane is open — the
		// textarea owns the keyboard then. Esc still closes via the branch
		// above. R from another zone is treated as "open from current
		// selection if any" — silent no-op when nothing is selected.
		if (getDraftPane() !== null) return;
		if (zone !== 'requires_user') return;
		event.preventDefault();
		switch (action.kind) {
			case 'next': void moveSelection(1); break;
			case 'prev': void moveSelection(-1); break;
			case 'archive': void archiveSelected(); break;
			case 'snooze': openSnoozeForSelected(); break;
			case 'undo': void undoOrHint(); break;
			case 'reply': openReplyForSelected(); break;
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

	// Resolve the item referenced by the open pane. Each save echo re-renders
	// InboxView, so a `{@const}` search would scan up to 150 entries per
	// keystroke-batch — $derived caches until pane id or bucket arrays change.
	const paneItem = $derived.by((): InboxItem | null => {
		const pane = getDraftPane();
		if (!pane) return null;
		return getInboxItems('requires_user').find((i) => i.id === pane.itemId)
			?? getInboxItems('draft_ready').find((i) => i.id === pane.itemId)
			?? getInboxItems('auto_handled').find((i) => i.id === pane.itemId)
			?? null;
	});

	const readingOpen = $derived(getSelectedItemId() !== null);

	// Compose-vs-active-Reply collision (PRD §"Compose-vs active Reply-Draft
	// collision" round-2 U14). When the user clicks Compose while a reply
	// draft pane is open, prompt the three-way modal. Reply drafts are
	// already auto-saved by DraftReplyPane's keystroke handler — the
	// "Save+New" path just closes the pane, "Discard" same, "Cancel" stays.
	let composeCollision = $state(false);

	function onComposeClick(): void {
		if (getDraftPane() !== null) {
			composeCollision = true;
		} else {
			openCompose();
		}
	}

	function resolveCollisionSaveAndOpen(): void {
		// Reply draft is already auto-saved via DraftReplyPane's autosave —
		// closing the pane is enough. If a future regression breaks autosave,
		// this is the layering point to add an explicit flush.
		closeDraftPane();
		composeCollision = false;
		openCompose();
	}

	function resolveCollisionDiscardAndOpen(): void {
		// Per PRD: lost edits not recoverable beyond the most recent autosave.
		closeDraftPane();
		composeCollision = false;
		openCompose();
	}
</script>

<!-- Two-pane layout (PR 3b §Architecture):
     - <md (mobile): the list takes the full screen; clicking an item swaps in
       the ReadingPane (full-screen), back-button (showBack) closes back to list.
     - ≥md: list = 30% left column, reading-pane = 70% right column. Reading-pane
       shows an empty-state until an item is selected.
     The 25/40/35 three-pane split with the Mail-Context-Sidebar lands in Phase 4. -->
<div class="flex h-full" role="region" aria-label={t('inbox.title')}>
<div
	class="{readingOpen ? 'hidden md:flex' : 'flex'} flex-col md:w-[30%] xl:w-[30%] md:border-r md:border-border min-w-0 overflow-y-auto"
	aria-live="polite"
>
<div class="p-4 sm:p-6 pb-[max(1rem,env(safe-area-inset-bottom))]">
	<div class="flex items-center justify-between flex-wrap gap-y-2 mb-4">
		<h1 class="text-xl font-light tracking-tight">{t('inbox.title')}</h1>
		<div class="flex items-center gap-3 flex-wrap">
			<button
				type="button"
				onclick={() => onComposeClick()}
				class="rounded-[var(--radius-sm)] border border-accent bg-accent text-accent-text px-3 py-1.5 text-[11px] hover:opacity-90"
			>{t('inbox.compose_new')}</button>
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
		{@const reclassifyBanner = getReclassifyBanner()}
		<ColdStartBanner />
		<InboxSearchBar value={searchQuery} onChange={(q) => (searchQuery = q)} />
		<InboxBulkBar />
		{#if reclassifyBanner}
			<div
				class="mb-3 flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-accent bg-accent/5 px-3 py-2 text-[12px] text-text"
				role="status"
				aria-live="polite"
			>
				<span>{t('inbox.reclassify_banner_text').replace('{count}', String(reclassifyBanner.count))}</span>
				<div class="flex items-center gap-1.5">
					<button
						type="button"
						class="rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-muted hover:text-text"
						onclick={() => {
							void loadInboxCounts();
							void loadInboxItems(zone);
							dismissReclassifyBanner();
						}}
					>{t('inbox.reclassify_banner_refresh')}</button>
					<button
						type="button"
						class="rounded-[var(--radius-sm)] px-2 py-1 text-[11px] text-text-subtle hover:text-text"
						onclick={() => dismissReclassifyBanner()}
						aria-label={t('inbox.reclassify_banner_dismiss')}
					>×</button>
				</div>
			</div>
		{/if}
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
				{@const allEmpty = counts.requires_user === 0 && counts.draft_ready === 0 && counts.auto_handled === 0}
				{#if allEmpty}
					<div class="mt-3">
						<button
							type="button"
							onclick={async () => {
								coldStartButtonBusy = true;
								try { await runColdStartBackfillForAllAccounts(); }
								finally { coldStartButtonBusy = false; }
							}}
							disabled={coldStartButtonBusy}
							class="text-[12px] px-3 py-1.5 rounded-[var(--radius-sm)] border border-border hover:bg-bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{coldStartButtonBusy ? t('inbox.cold_start_trigger_busy') : t('inbox.cold_start_trigger_button')}
						</button>
						<p class="text-[11px] text-text-subtle mt-1.5">{t('inbox.cold_start_trigger_hint')}</p>
					</div>
				{/if}
			{:else}
				{@const visibleIds = items.map((i) => i.id)}
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
								<input
									type="checkbox"
									class="mt-1 shrink-0 cursor-pointer"
									checked={isSelectedForBulk(item.id)}
									onclick={(e) => {
										const evt = e as MouseEvent;
										toggleBulkSelection(item.id, visibleIds, evt.shiftKey);
									}}
									aria-label={`Auswählen: ${item.subject || item.reasonDe}`}
								/>
								<button
									type="button"
									class="min-w-0 flex-1 text-left cursor-pointer"
									onclick={() => {
										selectedItemId = item.id;
										void openItem(item.id);
									}}
									aria-label={`${t('inbox.reading_open')}: ${item.subject || item.reasonDe}`}
								>
									<div class="flex items-center justify-between gap-2 mb-0.5">
										<span class="text-sm text-text truncate" title={item.fromAddress || item.accountId}>
											{item.fromName || item.fromAddress || accountShortLabel(item.accountId)}
										</span>
										<span class="text-[11px] text-text-subtle shrink-0">
											{dateFormat(item.mailDate ?? item.classifiedAt)}
										</span>
									</div>
									{#if item.subject}
										<p class="text-sm font-medium text-text leading-tight truncate mb-1" title={item.subject}>
											{item.subject}
										</p>
									{/if}
									<div class="flex items-center gap-2 text-[11px] text-text-subtle mb-1">
										<span title={item.accountId}>📬 {accountShortLabel(item.accountId)}</span>
										<span aria-hidden="true">·</span>
										<span>{channelLabel(item.channel)}</span>
									</div>
									<p class="text-sm text-text leading-relaxed">{item.reasonDe}</p>
									{#if item.classifierVersion === 'sensitive-prefilter'}
										<p class="text-[11px] text-warning mt-1" aria-label="sensitive content">
											⚠ {t('inbox.action_reply')}
										</p>
									{/if}
								</button>
								{#if zone === 'requires_user' && !item.userAction}
									<div class="flex items-center gap-1 shrink-0">
										<button
											onclick={() => openReplyFor(item)}
											class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[36px] pointer-coarse:min-h-[44px] pointer-coarse:px-4"
											aria-label={t('inbox.action_draft_reply')}
										>{t('inbox.action_draft_reply')}</button>
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
	</div>
	<!-- Reading-pane column -->
	<div
		class="{readingOpen ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0 overflow-hidden"
	>
		<InboxReadingPane
			onReply={(item) => void openDraftPane(item.id)}
			onActionApplied={() => {
				void loadInboxCounts();
				void loadInboxItems(zone);
			}}
			showBack
		/>
	</div>
</div>

<KeyboardShortcutsHelp open={helpOpen} onClose={() => (helpOpen = false)} />

{#if getDraftPane() !== null}
	<DraftReplyPane item={paneItem} />
{/if}

{#if isComposeOpen()}
	<InboxComposePane />
{/if}

{#if composeCollision}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-bg/60"
		role="dialog"
		aria-modal="true"
		aria-labelledby="compose-collision-title"
	>
		<div class="max-w-md rounded-[var(--radius-md)] border border-border bg-bg p-4 shadow-xl">
			<h2 id="compose-collision-title" class="mb-2 text-sm font-medium text-text">
				{t('inbox.compose_collision_title')}
			</h2>
			<p class="mb-4 text-[12px] text-text-muted">{t('inbox.compose_collision_body')}</p>
			<div class="flex flex-wrap items-center justify-end gap-2">
				<button
					type="button"
					class="rounded-[var(--radius-sm)] px-3 py-1.5 text-[11px] text-text-subtle hover:text-text"
					onclick={() => (composeCollision = false)}
				>{t('inbox.compose_collision_cancel')}</button>
				<button
					type="button"
					class="rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-1.5 text-[11px] text-text-muted hover:text-text"
					onclick={() => resolveCollisionDiscardAndOpen()}
				>{t('inbox.compose_collision_discard')}</button>
				<button
					type="button"
					class="rounded-[var(--radius-sm)] border border-accent bg-accent text-accent-text px-3 py-1.5 text-[11px] hover:opacity-90"
					onclick={() => resolveCollisionSaveAndOpen()}
				>{t('inbox.compose_collision_save_new')}</button>
			</div>
		</div>
	</div>
{/if}

<InboxUndoToast currentZone={zone} />

