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
		getSnoozedCount,
		getSnoozedItems,
		isComposeOpen,
		isInboxAvailable,
		isLoading,
		isLoadingSnoozed,
		isSelectedForBulk,
		loadInboxCounts,
		loadInboxItems,
		loadSnoozedItems,
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
		type InboxItem,
		type InboxZone,
	} from '../stores/inbox.svelte.js';
	import { addToast } from '../stores/toast.svelte.js';
	import { accountShortLabel } from '../utils/account-label.js';
	import { inboxHeadline } from '../utils/inbox-headline.js';
	import { keyToInboxAction, shouldIgnoreShortcut } from '../utils/inbox-shortcuts.js';
	import { isTouchPrimary } from '../utils/touch-detect.js';
	import Checkbox from '../primitives/Checkbox.svelte';
	import ColdStartBanner from './ColdStartBanner.svelte';
	import DraftReplyPane from './DraftReplyPane.svelte';
	import InboxBulkBar from './InboxBulkBar.svelte';
	import InboxComposePane from './InboxComposePane.svelte';
	import InboxContextSidebar from './InboxContextSidebar.svelte';
	import InboxKopilotCard from './InboxKopilotCard.svelte';
	import InboxReadingPane from './InboxReadingPane.svelte';
	import InboxSearchBar from './InboxSearchBar.svelte';
	import InboxTriagePane from './InboxTriagePane.svelte';
	import InboxUndoToast from './InboxUndoToast.svelte';
	import InboxZoneRail from './InboxZoneRail.svelte';
	import KeyboardShortcutsHelp from './KeyboardShortcutsHelp.svelte';

	let zone = $state<InboxZone>('requires_user');
	let openSnoozeFor = $state<string | null>(null);
	let selectedItemId = $state<string | null>(null);
	let searchQuery = $state('');
	let helpOpen = $state(false);
	let coldStartButtonBusy = $state(false);
	let triageMode = $state(false);
	// Lifted out of TriagePane so the `s` keyboard shortcut can open the snooze
	// menu inside the focused-mail pane without bridging refs.
	let triageSnoozeOpen = $state(false);
	// Gate items-fetch on counts-loaded so the $effect below doesn't race
	// onMount's initial load (without this the bucket gets fetched twice).
	let countsLoaded = $state(false);
	// Mail-Context-Sidebar drawer state (md/sm). Always-visible split on lg+.
	let contextOpen = $state(false);
	// Persistent collapse state — applies on lg+ where the sidebar otherwise
	// shows as an inline split column. Read once on mount; written on every
	// toggle so the choice survives a refresh. md/sm uses `contextOpen`.
	let contextCollapsed = $state(false);
	if (typeof window !== 'undefined') {
		contextCollapsed = window.localStorage.getItem('inbox.contextCollapsed') === '1';
	}
	function toggleContextCollapsed(): void {
		contextCollapsed = !contextCollapsed;
		if (typeof window !== 'undefined') {
			window.localStorage.setItem('inbox.contextCollapsed', contextCollapsed ? '1' : '0');
		}
	}
	const touchPrimary = isTouchPrimary();

	let cleanupVisibility: (() => void) | undefined;
	let cleanupColdStart: (() => void) | undefined;
	let cleanupColdStartListener: (() => void) | undefined;
	let cleanupKeyHandler: (() => void) | undefined;

	onMount(async () => {
		await loadInboxCounts();
		countsLoaded = true;
		cleanupColdStart = startColdStartPolling();
		cleanupColdStartListener = onColdStartCompletion(() => {
			void loadInboxCounts();
			if (zone === 'snoozed') void loadSnoozedItems();
			else void loadInboxItems(zone);
		});
		cleanupVisibility = startInboxVisibilityRefresh();
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
			if (zone === 'snoozed') {
				void loadSnoozedItems(50, 0);
			} else {
				void loadInboxItems(zone, 50, 0, searchQuery);
			}
			if (zone !== 'requires_user') selectedItemId = null;
			openSnoozeFor = null;
		}
	});

	// Triage is needs-you only; force it off when the user navigates away.
	$effect(() => {
		if (zone !== 'requires_user' && triageMode) {
			triageMode = false;
			triageSnoozeOpen = false;
		}
	});

	function visibleItems(): InboxItem[] {
		if (zone === 'snoozed') return getSnoozedItems();
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
		if (triageMode) {
			void openItem(targetId);
			return;
		}
		await tick();
		if (typeof document === 'undefined') return;
		// CSS.escape: the id comes from the API and is well-typed today, but a
		// malformed upstream value containing `"` or `]` would otherwise corrupt
		// the attribute selector. `behavior:'auto'` keeps rapid J/K from
		// stacking smooth-scroll animations.
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
		const after = visibleItems();
		const nextId = after.length === 0
			? null
			: after[Math.min(idx, after.length - 1)]?.id ?? null;
		selectedItemId = nextId;
		// In triage mode the reader IS the queue cursor — keep it in sync with
		// the freshly-stepped selection, otherwise the just-archived mail's
		// body lingers until the user nudges j/k.
		if (triageMode) {
			if (nextId !== null) void openItem(nextId);
			else closeItem();
		}
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
		if (triageSnoozeOpen) { triageSnoozeOpen = false; return; }
		if (openSnoozeFor !== null) { openSnoozeFor = null; return; }
		// In triage mode, Escape exits triage rather than closing the item —
		// matches the user's mental model: Esc backs out of the focused mode.
		if (triageMode) { triageMode = false; return; }
	}

	function openReplyForSelected(): void {
		const item = visibleItems().find((i) => i.id === selectedItemId);
		if (!item) return;
		void openItem(item.id);
		void openDraftPane(item.id);
	}

	function openReplyFor(item: InboxItem): void {
		void openItem(item.id);
		void openDraftPane(item.id);
	}

	function pickItem(item: InboxItem): void {
		selectedItemId = item.id;
		void openItem(item.id);
	}

	function startTriage(): void {
		if (zone !== 'requires_user') zone = 'requires_user';
		const queue = visibleItems();
		if (queue.length === 0) {
			addToast(t('inbox.triage_done'), 'info');
			return;
		}
		// Re-pick the first item when the prior selection is gone from the
		// queue (archived/snoozed from another tab) — otherwise triage opens
		// to an empty pane until the user nudges j/k.
		const stillThere = selectedItemId !== null && queue.some((i) => i.id === selectedItemId);
		if (!stillThere) {
			selectedItemId = queue[0]!.id;
			void openItem(queue[0]!.id);
		}
		triageMode = true;
	}

	function exitTriage(): void {
		triageMode = false;
		// Reset the bindable so a future re-entry doesn't propagate a stale
		// snoozeMenuOpen=true into TriagePane on mount.
		triageSnoozeOpen = false;
	}

	function toggleTriage(): void {
		if (triageMode) exitTriage();
		else startTriage();
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (!event.isTrusted) return;
		if (shouldIgnoreShortcut(event.target)) return;
		const action = keyToInboxAction(event);
		if (!action) return;
		if (action.kind === 'toggle_help') {
			event.preventDefault();
			helpOpen = !helpOpen;
			return;
		}
		if (action.kind === 'close') {
			if (helpOpen || getDraftPane() !== null || triageSnoozeOpen || openSnoozeFor !== null || triageMode) {
				event.preventDefault();
				closeOverlays();
			}
			return;
		}
		if (action.kind === 'toggle_triage') {
			event.preventDefault();
			toggleTriage();
			return;
		}
		if (getDraftPane() !== null) return;
		if (zone !== 'requires_user') return;
		event.preventDefault();
		switch (action.kind) {
			case 'next': void moveSelection(1); break;
			case 'prev': void moveSelection(-1); break;
			case 'archive': void archiveSelected(); break;
			case 'snooze':
				// In triage the list isn't rendered, so the legacy openSnoozeFor
				// pill would be invisible — drive the TriagePane menu via its
				// bindable prop instead.
				if (triageMode) triageSnoozeOpen = !triageSnoozeOpen;
				else openSnoozeForSelected();
				break;
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
	const snoozePresets = $derived<ReadonlyArray<{ label: string; deltaMs: number }>>([
		{ label: t('inbox.snooze_1h'), deltaMs: HOUR_MS },
		{ label: t('inbox.snooze_today'), deltaMs: 6 * HOUR_MS },
		{ label: t('inbox.snooze_tomorrow'), deltaMs: DAY_MS },
		{ label: t('inbox.snooze_week'), deltaMs: 7 * DAY_MS },
	]);

	async function onArchive(item: InboxItem): Promise<void> {
		await setItemAction(item.id, 'archived');
		if (zone === 'snoozed') {
			await loadSnoozedItems();
			await loadInboxCounts();
		}
	}

	async function onSnoozePreset(item: InboxItem, deltaMs: number): Promise<void> {
		const until = new Date(Date.now() + deltaMs);
		await setItemSnooze(item.id, until);
		openSnoozeFor = null;
	}

	async function unsnooze(item: InboxItem): Promise<void> {
		await setItemSnooze(item.id, null);
		await loadSnoozedItems();
		await loadInboxCounts();
	}

	function snoozeCountdown(until: string): string {
		const d = new Date(until);
		if (Number.isNaN(d.getTime())) return '';
		const ms = d.getTime() - Date.now();
		if (ms < 0) return dateFormat(until);
		const min = Math.round(ms / 60_000);
		const hr = Math.round(ms / 3_600_000);
		const day = Math.round(ms / 86_400_000);
		const isDE = getLocale() === 'de';
		if (min < 60) return isDE ? `in ${min} Min` : `in ${min} min`;
		if (hr < 24) return isDE ? `in ${hr} Std` : `in ${hr}h`;
		if (day < 14) return isDE ? `in ${day} Tagen` : `in ${day}d`;
		return dateFormat(until);
	}

	const paneItem = $derived.by((): InboxItem | null => {
		const pane = getDraftPane();
		if (!pane) return null;
		return getInboxItems('requires_user').find((i) => i.id === pane.itemId)
			?? getInboxItems('draft_ready').find((i) => i.id === pane.itemId)
			?? getInboxItems('auto_handled').find((i) => i.id === pane.itemId)
			?? null;
	});

	const readingOpen = $derived(getSelectedItemId() !== null);

	let composeCollision = $state(false);

	function onComposeClick(): void {
		if (getDraftPane() !== null) {
			composeCollision = true;
		} else {
			openCompose();
		}
	}

	function resolveCollisionSaveAndOpen(): void {
		closeDraftPane();
		composeCollision = false;
		openCompose();
	}

	function resolveCollisionDiscardAndOpen(): void {
		closeDraftPane();
		composeCollision = false;
		openCompose();
	}

	function refreshAfterAction(): void {
		void loadInboxCounts();
		if (zone === 'snoozed') void loadSnoozedItems();
		else void loadInboxItems(zone);
	}
</script>

<!--
	3-pane layout (Variant B-default + C-toggle):
	- < md (mobile): single-pane stack. Zone selector lives as horizontal pills
	  at the top of the list view; clicking an item swaps in the reading pane.
	  The zone-rail is hidden — its width budget is too expensive on phones.
	- ≥ md: zone-rail (left, ~180px) + list (mid, fixed ~360-400px) + reader (right, flex-1).
	  Reader defaults to the Inbox-Kopilot card; selecting an item swaps in
	  the reading pane.
	- Triage mode: zone-rail stays, list+reader columns are replaced by the
	  full-width triage pane (one-mail-at-a-time). Toggle via the rail button
	  or `t` shortcut. Esc exits.
-->
<div class="flex h-full" role="region" aria-label={t('inbox.title')}>
	<InboxZoneRail
		{zone}
		onZoneChange={(z) => (zone = z)}
		onCompose={onComposeClick}
		onTriageToggle={toggleTriage}
		triageActive={triageMode}
		onHelp={() => (helpOpen = true)}
		showHelp={!touchPrimary}
	/>

	{#if triageMode}
		<!-- Triage mode owns the entire right side on desktop, full screen on mobile. -->
		<div class="flex-1 flex flex-col min-w-0 overflow-hidden">
			<InboxTriagePane
				onReply={(item) => { void openItem(item.id); void openDraftPane(item.id); }}
				onActionApplied={refreshAfterAction}
				onExit={exitTriage}
				bind:snoozeMenuOpen={triageSnoozeOpen}
			/>
		</div>
	{:else}
		<!-- List column -->
		<div
			class="{readingOpen ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-[360px] lg:w-[400px] shrink-0 md:border-r md:border-border min-w-0 overflow-y-auto"
			aria-live="polite"
		>
			<div class="p-4 sm:p-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
				<!-- Mobile-only header with title + compose. The desktop header lives
					in the zone-rail's bottom section. -->
				<div class="flex items-center justify-between gap-2 mb-3 md:hidden">
					<h1 class="text-lg font-light tracking-tight">{t('inbox.title')}</h1>
					<button
						type="button"
						onclick={() => onComposeClick()}
						class="rounded-[var(--radius-sm)] border border-accent bg-accent text-accent-text px-3 py-1.5 text-[11px] hover:opacity-90"
					>{t('inbox.compose_new')}</button>
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
										refreshAfterAction();
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

					<!-- Mobile-only zone pills (md+ uses InboxZoneRail). -->
					<div
						class="md:hidden flex gap-1 mb-3 overflow-x-auto scrollbar-none -mx-4 px-4 py-1"
						role="tablist"
						aria-label={t('inbox.title')}
					>
						<button
							role="tab"
							aria-selected={zone === 'requires_user'}
							onclick={() => (zone = 'requires_user')}
							class="shrink-0 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'requires_user' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
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
							class="shrink-0 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'draft_ready' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
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
							class="shrink-0 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'auto_handled' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
						>
							<span>{t('inbox.zone_handled')}</span>
							{#if counts.auto_handled > 0}
								<span class="rounded-full bg-bg-muted text-text-muted px-1.5 text-[10px] font-mono">{counts.auto_handled}</span>
							{/if}
						</button>
						<button
							role="tab"
							aria-selected={zone === 'snoozed'}
							onclick={() => (zone = 'snoozed')}
							class="shrink-0 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-colors flex items-center gap-2 {zone === 'snoozed' ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
						>
							<span>{t('inbox.zone_snoozed')}</span>
							{#if getSnoozedCount() > 0}
								<span class="rounded-full bg-bg-muted text-text-muted px-1.5 text-[10px] font-mono">{getSnoozedCount()}</span>
							{/if}
						</button>
					</div>

					{#if zone === 'snoozed' ? isLoadingSnoozed() : isLoading(zone)}
						<p class="text-text-subtle text-sm">{t('inbox.loading')}</p>
					{:else}
						<!-- Filter !userAction here too so the list mirrors visibleItems()
							in the keyboard handler — otherwise just-archived rows flash. -->
						{@const items = zone === 'snoozed' ? getSnoozedItems() : getInboxItems(zone).filter((i) => !i.userAction)}
						{#if items.length === 0}
							<p class="text-text-subtle text-sm">
								{#if zone === 'requires_user'}{t('inbox.empty_needs_you')}
								{:else if zone === 'draft_ready'}{t('inbox.empty_drafted')}
								{:else if zone === 'snoozed'}{t('inbox.empty_snoozed')}
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
							<!-- Mid-density list rows (B-variant): two visible lines per row.
								Line 1: headline (subject or AI fallback), date.
								Line 2: sender · channel · account.
								Action chips removed from the row — the reader has them, bulk bar
								handles multi-select, snooze opens inline only when explicitly
								requested. Massive vertical-density win vs. the prior card layout. -->
							<ul class="space-y-0.5" role="list">
								{#each items as item (item.id)}
									{@const isActiveSelection = (zone === 'requires_user' && selectedItemId === item.id) || (readingOpen && getSelectedItemId() === item.id)}
									<li
										role="listitem"
										data-inbox-item-id={item.id}
										aria-current={isActiveSelection ? 'true' : undefined}
										class="rounded-[var(--radius-sm)] border transition-colors {isActiveSelection ? 'border-accent bg-accent/5' : 'border-transparent hover:border-border hover:bg-bg-subtle/60'}"
									>
										<div class="flex items-start gap-2 px-2 py-2">
											<div class="mt-1">
												<Checkbox
													checked={isSelectedForBulk(item.id)}
													onclick={(e) => toggleBulkSelection(item.id, visibleIds, e.shiftKey)}
													ariaLabel={`Auswählen: ${item.subject || item.reasonDe}`}
												/>
											</div>
											<button
												type="button"
												class="min-w-0 flex-1 text-left cursor-pointer"
												onclick={() => {
													selectedItemId = item.id;
													void openItem(item.id);
													// Draft-ready zone short-circuit: the whole point of
													// this zone is "lynox already drafted a reply" — auto-
													// open the draft pane so the user sees + edits + sends
													// in one click instead of three.
													if (zone === 'draft_ready') void openDraftPane(item.id);
												}}
												aria-label={`${t('inbox.reading_open')}: ${item.subject || item.reasonDe}`}
											>
												<div class="flex items-baseline justify-between gap-2 mb-0.5">
													<p class="text-sm font-medium text-text leading-snug truncate flex items-center gap-1.5" title={item.subject || item.reasonDe}>
														{#if zone === 'snoozed' && item.notifyOnUnsnooze === true}
															<!-- Reminder badge — distinguishes "remind me at X" from silent
															     snooze in the same Snoozed zone. -->
															<span class="shrink-0 inline-block w-1.5 h-1.5 rounded-full bg-accent-text" aria-label={t('inbox.reminder_badge_label')} title={t('inbox.reminder_badge_label')}></span>
														{/if}
														<span class="truncate">{inboxHeadline(item)}</span>
													</p>
													<span class="shrink-0 text-[11px] text-text-subtle tabular-nums">
														{zone === 'snoozed' && item.snoozeUntil
															? snoozeCountdown(item.snoozeUntil)
															: dateFormat(item.mailDate ?? item.classifiedAt)}
													</span>
												</div>
												<div class="flex items-center gap-1.5 text-[11px] text-text-subtle min-w-0">
													<span class="truncate" title={item.fromAddress || item.accountId}>
														{item.fromName || item.fromAddress || accountShortLabel(item.accountId)}
													</span>
													<span aria-hidden="true">·</span>
													<span class="shrink-0">{channelLabel(item.channel)}</span>
													{#if item.classifierVersion === 'sensitive-prefilter'}
														<span aria-hidden="true">·</span>
														<span class="shrink-0 text-warning" aria-label="sensitive content">⚠</span>
													{/if}
												</div>
											</button>
										</div>
										{#if zone === 'snoozed'}
											<div class="flex flex-wrap items-center gap-1 px-2 pb-2 pl-9">
												<button
													onclick={() => void unsnooze(item)}
													class="rounded-[var(--radius-sm)] border border-accent bg-accent/10 text-accent-text px-2.5 py-1 text-[11px] hover:opacity-90 min-h-[32px] pointer-coarse:min-h-[44px]"
													aria-label={t('inbox.action_unsnooze')}
												>{t('inbox.action_unsnooze')}</button>
												<button
													onclick={() => void onArchive(item)}
													class="rounded-[var(--radius-sm)] border border-border bg-bg px-2.5 py-1 text-[11px] text-text-muted hover:text-text hover:border-border-hover min-h-[32px] pointer-coarse:min-h-[44px]"
													aria-label={t('inbox.action_archive')}
												>{t('inbox.action_archive')}</button>
											</div>
										{/if}
										{#if openSnoozeFor === item.id}
											<div class="flex flex-wrap gap-1.5 px-2 pb-2 pl-9">
												{#each snoozePresets as preset (preset.label)}
													<button
														onclick={() => void onSnoozePreset(item, preset.deltaMs)}
														class="rounded-[var(--radius-sm)] bg-bg-muted text-text-muted hover:text-text px-2.5 py-1 text-[11px] min-h-[32px] pointer-coarse:min-h-[44px]"
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

		<!-- Reader column (md+): defaults to Kopilot card, swaps to ReadingPane when an item is selected.
			Mail-Context-Sidebar mounts ONCE — its wrapper switches between an
			lg+ inline split column and an md/sm drawer overlay via CSS-only
			positioning so the component fetches context exactly once per item. -->
		<div
			class="{readingOpen ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 overflow-hidden"
		>
			<div class="flex flex-1 flex-col min-w-0 overflow-hidden relative">
				{#if readingOpen}
					<InboxReadingPane
						onReply={(item) => { void openItem(item.id); void openDraftPane(item.id); }}
						onActionApplied={refreshAfterAction}
						showBack
						{contextCollapsed}
						onToggleContext={toggleContextCollapsed}
					/>
					<!-- md/sm-only drawer trigger — lg+ uses the chevron inside the
						reading-pane header so it never overlaps action buttons. -->
					<button
						type="button"
						class="absolute right-3 top-3 z-30 lg:hidden rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1 text-[11px] text-text-subtle hover:text-text hover:border-border-hover"
						onclick={() => (contextOpen = !contextOpen)}
						aria-pressed={contextOpen}
						aria-label={contextOpen ? t('inbox.context_sidebar_close') : t('inbox.context_sidebar_open')}
					>≡</button>
					{#if contextOpen}
						<!-- md/sm-only backdrop; tap-outside closes. -->
						<button
							type="button"
							class="absolute inset-0 z-10 lg:hidden bg-bg/40 cursor-default"
							aria-label={t('inbox.context_sidebar_close')}
							onclick={() => (contextOpen = false)}
						></button>
					{/if}
				{:else}
					<InboxKopilotCard
						onPickItem={pickItem}
						onStartTriage={startTriage}
					/>
				{/if}
			</div>
			{#if readingOpen}
				<!-- Sidebar wrapper: inline split on lg+ (unless user collapsed it),
					absolutely-positioned drawer on md/sm. Single mount → single
					context fetch per item. lg-collapse hides the column entirely
					so the reading pane reclaims the width (fixes action-button
					clipping on narrow viewports). -->
				<div
					class="
						{contextOpen ? 'absolute z-20 right-0 top-0 h-full w-[85%] max-w-[320px] shadow-xl' : 'hidden'}
						{contextCollapsed ? 'lg:hidden' : 'lg:relative lg:flex lg:z-auto lg:right-auto lg:top-auto lg:h-auto lg:w-[300px] xl:w-[340px] lg:shrink-0 lg:shadow-none lg:max-w-none'}
					"
				>
					<InboxContextSidebar
						itemId={getSelectedItemId()}
						onClose={contextOpen ? () => (contextOpen = false) : undefined}
					/>
				</div>
			{/if}
		</div>
	{/if}
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

<InboxUndoToast currentZone={zone === 'snoozed' ? 'requires_user' : zone} />
