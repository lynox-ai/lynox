<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount, onDestroy } from 'svelte';
	import { slide } from 'svelte/transition';
	import { newChat, resumeThread, getSessionId, getSkipExtraction, toggleSkipExtraction } from '../stores/chat.svelte.js';
	import { loadThreads, getThreads, archiveThread, deleteThread, renameThread, toggleFavorite, onActiveThreadRemoved, startVisibilityRefresh, startActiveRunsPoll, getRunStatus, markThreadRead } from '../stores/threads.svelte.js';
	import { t, getLocale, setLocale } from '../i18n.svelte.js';
	import { timeAgo } from '../utils/time.js';
	import { hasVoicePrefix, stripVoicePrefix, MIC_SVG_PATH } from '../utils/voice-prefix.js';
	import { getApiBase, getContextPanelEnabled } from '../config.svelte.js';
	import Icon from '../primitives/Icon.svelte';
	import StatusBar from './StatusBar.svelte';
	import SetupBanner from './SetupBanner.svelte';
	import PublicDemoBanner from './PublicDemoBanner.svelte';
	import ContextPanel from './ContextPanel.svelte';
	import CommandPalette from './CommandPalette.svelte';
	import { isSessionExpired, clearSessionExpired } from '../stores/session.svelte.js';
	import { installApiFetchInterceptor } from '../utils/api-fetch-interceptor.js';
	import type { Snippet } from 'svelte';

	let { children, userSlot }: {
		children: Snippet;
		userSlot?: Snippet;
	} = $props();

	let sidebarOpen = $state(false);
	let expandedSection = $state<string | null>(null);
	let swipedThreadId = $state<string | null>(null);
	let dragStartX = 0;
	let dragNode: HTMLElement | null = null;
	let renamingThreadId = $state<string | null>(null);
	let renameValue = $state('');
	let langDropdownOpen = $state(false);
	// Icon-rail collapse state (variant B). Pinned wins; otherwise hovered
	// keeps the rail expanded while the cursor is over it. Pin survives
	// reloads via localStorage so the user's preference sticks.
	let railPinned = $state(false);
	let railHovered = $state(false);
	let railLeaveTimer: ReturnType<typeof setTimeout> | null = null;
	const railExpanded = $derived(railPinned || railHovered);
	// Desktop = the persistent rail (≥ md). On mobile the full-width drawer shows
	// the threads list based on the DRAWER being open (sidebarOpen), NOT hover/pin
	// — otherwise Option A (no touch-hover) would hide mobile chat-history, and a
	// desktop pin leaked via localStorage would expand it under a tapping finger.
	let isDesktop = $state(false);
	let railMq: MediaQueryList | null = null;
	const onRailMq = () => { isDesktop = railMq?.matches ?? false; };
	const navExpanded = $derived(isDesktop ? railExpanded : sidebarOpen);

	function focusOnMount(node: HTMLElement) { node.focus(); }

	function startRename(threadId: string, currentTitle: string) {
		renamingThreadId = threadId;
		renameValue = currentTitle;
	}
	async function commitRename(threadId: string) {
		const trimmed = renameValue.trim();
		if (trimmed && renamingThreadId === threadId) {
			await renameThread(threadId, trimmed);
		}
		renamingThreadId = null;
	}
	function cancelRename() {
		renamingThreadId = null;
	}
	// ── Header session-title rename ───────────────────────────────────────
	// Manual rename of the ACTIVE conversation from the header. Auto-naming
	// only fires on the first message (session.ts generateThreadTitle), so a
	// manually set title is never clobbered — no "manual" flag needed. Kept in
	// its own state from the sidebar inline-rename above, otherwise editing the
	// active thread here would also open an input in the thread list.
	let headerRenaming = $state(false);
	let headerRenameValue = $state('');
	function startHeaderRename() {
		const ct = getThreads().find((thr) => thr.id === getSessionId());
		headerRenameValue = ct?.title ?? '';
		headerRenaming = true;
	}
	async function commitHeaderRename() {
		if (!headerRenaming) return;
		const id = getSessionId();
		const trimmed = headerRenameValue.trim();
		headerRenaming = false;
		if (id && trimmed) await renameThread(id, trimmed);
	}
	function cancelHeaderRename() {
		headerRenaming = false;
	}
	async function confirmDelete(threadId: string) {
		if (confirm(t('threads.confirm_delete'))) {
			await deleteThread(threadId, getSessionId());
		}
	}

	// ── Per-thread 3-dot menu ─────────────────────────────────────────────
	// Replaces the hover-only icon row that was unreachable on touch devices.
	// One menu open at a time. `closeMenu` runs on outside-click + on every
	// action so the menu doesn't linger after the user has decided.
	//
	// Positioning quirk: the row sits inside `<li overflow-hidden>` (needed
	// for the swipe-reveal effect) AND `<ul overflow-y-auto>` (max-h-72).
	// An absolutely-positioned popover would be clipped by either parent —
	// the kebab clicks, but the menu renders invisibly. So we capture the
	// kebab's viewport rect on open and render the menu as `position: fixed`
	// at the nav root, escaping all ancestor overflows.
	let openMenuId = $state<string | null>(null);
	let menuAnchor = $state<DOMRect | null>(null);
	// Free-text filter over thread titles, client-side. Server-side `q` param
	// is an option for >1k thread accounts but the current ~50-thread typical
	// is fast enough to filter in-memory.
	let threadQuery = $state('');

	function filteredThreads() {
		const q = threadQuery.trim().toLowerCase();
		const all = getThreads();
		if (q.length === 0) return all;
		return all.filter((th) => {
			const hay = ((th.title ?? '') + ' ' + (th.id ?? '')).toLowerCase();
			return hay.includes(q);
		});
	}

	function toggleMenu(threadId: string, e: MouseEvent) {
		e.stopPropagation();
		if (openMenuId === threadId) {
			openMenuId = null;
			menuAnchor = null;
			return;
		}
		const btn = e.currentTarget as HTMLElement;
		menuAnchor = btn.getBoundingClientRect();
		openMenuId = threadId;
	}
	function closeMenu() {
		openMenuId = null;
		menuAnchor = null;
	}

	/**
	 * Filename slug shared by both export paths. Lowercase the title, collapse
	 * non-alphanumerics into hyphens, trim leading/trailing hyphens, cap at 60
	 * chars to stay below filesystem limits.
	 */
	function exportFilename(title: string | null, ext: 'md' | 'json'): string {
		const base = (title || 'thread').trim();
		const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
		const stamp = new Date().toISOString().slice(0, 10);
		return `lynox-thread-${slug || 'export'}-${stamp}.${ext}`;
	}

	/** Trigger a browser-side download of an in-memory blob. */
	function downloadBlob(content: string, mime: string, filename: string): void {
		const blob = new Blob([content], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	/**
	 * Export a thread as a Markdown file: one `# Title` header, then each
	 * message as `**You:** / **Assistant:** content`. Browser-side download.
	 * Useful for archiving / sharing decisions made in chat without
	 * needing a "view in browser" link.
	 */
	async function exportThread(threadId: string, title: string | null) {
		try {
			const res = await fetch(`${getApiBase()}/threads/${encodeURIComponent(threadId)}/messages?limit=10000`);
			if (!res.ok) {
				alert(t('threads.error_export'));
				return;
			}
			const data = (await res.json()) as { messages: Array<{ role: string; content?: unknown }> };
			const safeTitle = (title || 'thread').trim();
			const lines: string[] = [`# ${safeTitle}`, '', `_Exportiert am ${new Date().toLocaleString()}_`, ''];
			for (const m of data.messages ?? []) {
				const role = m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Assistant' : m.role;
				// `content` shape varies — string for simple messages, array of
				// blocks for tool/multi-modal. Stringify the array safely; plain
				// text passes through unchanged.
				const body = typeof m.content === 'string'
					? m.content
					: JSON.stringify(m.content, null, 2);
				lines.push(`**${role}:**`, '', body, '');
			}
			downloadBlob(lines.join('\n'), 'text/markdown', exportFilename(title, 'md'));
		} catch {
			alert(t('threads.error_export'));
		}
	}

	/**
	 * Export a thread as a structured JSON bundle: thread metadata + the full
	 * projected messages (tool_use/tool_result blocks preserved as objects, not
	 * stringified). Plus a `meta` envelope with engine version + git SHA from
	 * /api/health so the export is self-describing for debug. Markdown loses
	 * tool-call structure to text; this is the format to diff/grep.
	 */
	async function exportThreadJson(threadId: string, title: string | null) {
		try {
			const base = getApiBase();
			// Server-side comprehensive debug-export: thread + rendered messages +
			// per-run telemetry (provider, tokens/cost/cache, status, raw tool I/O,
			// prompt snapshots), secret-scrubbed. One round-trip.
			const res = await fetch(`${base}/threads/${encodeURIComponent(threadId)}/debug-export`);
			if (res.ok) {
				const bundle: unknown = await res.json();
				downloadBlob(JSON.stringify(bundle, null, 2), 'application/json', exportFilename(title, 'json'));
				return;
			}
			// Fallback for an older engine without /debug-export (e.g. mid-rollout):
			// the thin thread + messages bundle still exports.
			const [threadRes, msgRes] = await Promise.all([
				fetch(`${base}/threads/${encodeURIComponent(threadId)}`),
				fetch(`${base}/threads/${encodeURIComponent(threadId)}/messages?limit=10000`),
			]);
			if (!threadRes.ok || !msgRes.ok) {
				alert(t('threads.error_export'));
				return;
			}
			const threadData = (await threadRes.json()) as { thread?: unknown };
			const msgData = (await msgRes.json()) as { messages?: unknown };
			const bundle = {
				exported_at: new Date().toISOString(),
				exported_by: 'lynox web-ui (fallback)',
				thread: threadData.thread,
				messages: msgData.messages,
			};
			downloadBlob(JSON.stringify(bundle, null, 2), 'application/json', exportFilename(title, 'json'));
		} catch {
			alert(t('threads.error_export'));
		}
	}

	function closeSwipe() {
		if (!swipedThreadId) return;
		const el = document.querySelector(`[data-swipe-thread="${swipedThreadId}"]`) as HTMLElement | null;
		if (el) el.style.transform = '';
		swipedThreadId = null;
	}

	function onSwipeStart(e: TouchEvent, threadId: string) {
		dragStartX = e.touches[0].clientX;
		dragNode = e.currentTarget as HTMLElement;
		dragNode.style.transition = 'none';
		if (swipedThreadId && swipedThreadId !== threadId) closeSwipe();
	}

	function onSwipeMove(e: TouchEvent) {
		if (!dragNode) return;
		const dx = e.touches[0].clientX - dragStartX;
		if (dx < 0) dragNode.style.transform = `translateX(${Math.max(dx, -72)}px)`;
		else if (swipedThreadId) dragNode.style.transform = `translateX(${Math.min(-72 + dx, 0)}px)`;
	}

	function onSwipeEnd(threadId: string) {
		if (!dragNode) return;
		dragNode.style.transition = '';
		const match = /translateX\((-?\d+)/.exec(dragNode.style.transform);
		const offset = match ? parseInt(match[1]) : 0;
		if (offset < -36) {
			dragNode.style.transform = 'translateX(-72px)';
			swipedThreadId = threadId;
		} else {
			dragNode.style.transform = '';
			if (swipedThreadId === threadId) swipedThreadId = null;
		}
		dragNode = null;
	}

	interface NavItem {
		href: string;
		labelKey: string;
		exact: boolean;
		icon: import('../primitives/icons.js').IconName;
		// 'threads' expands into the live thread list (Chat only). Undefined =
		// leaf entry; clicking navigates. Static sub-navs were retired in the
		// hub-consolidation refactor — sub-features live as hub-page tabs.
		type?: 'threads';
	}

	// Feature-flag gated nav entries. Fetched once on mount from the Engine.
	// When the flag is off we omit the entry entirely so non-pilot tenants see
	// no dead link.
	let inboxEnabled = $state(false);

	onMount(async () => {
		// Catch any /api/* 401 globally so a Safari-PWA cookie eviction
		// (or 30-day TTL expiry) surfaces as "Session abgelaufen" instead
		// of generic "Laden fehlgeschlagen" toasts in every view.
		installApiFetchInterceptor();

		// /inbox/counts returns 503 when the flag is off; treating ok=true as
		// "enabled" mirrors the store's own probe (see inbox.svelte.ts).
		try {
			const res = await fetch(`${getApiBase()}/inbox/counts`);
			inboxEnabled = res.ok;
		} catch {
			inboxEnabled = false;
		}
	});

	// Flat nav: no sidebar sub-nav (per PR #265). Sub-features live as tabs
	// inside each hub page. Chat keeps its threads dropdown — that's not a
	// sub-nav, it's the conversation history.
	const nav: NavItem[] = $derived.by(() => {
		const items: NavItem[] = [
			{ href: '/app', labelKey: 'nav.chat', exact: true, icon: 'chat', type: 'threads' },
		];
		if (inboxEnabled) {
			items.push({ href: '/app/inbox', labelKey: 'nav.inbox', exact: false, icon: 'inbox' });
		}
		items.push(
			// PRD-IA-V2 P2-PR-A: Activity is its own root (daily-frequency surface).
			// Position 3 per PRD nav table — between Inbox and Hub.
			{ href: '/app/activity', labelKey: 'nav.activity', exact: false, icon: 'clock' },
			{ href: '/app/hub', labelKey: 'nav.automation', exact: false, icon: 'workflow' },
			{ href: '/app/intelligence', labelKey: 'nav.intelligence', exact: false, icon: 'brain' },
			{ href: '/app/artifacts', labelKey: 'nav.artifacts', exact: false, icon: 'artifacts' },
		);
		return items;
	});

	// The Chat entry — its expanded thread list grows to fill the sidebar.
	// nav[0] is always Chat (see the `nav` builder above); kept as a derived
	// value so the `{#if chatItem}` guard satisfies noUncheckedIndexedAccess.
	const chatItem = $derived<NavItem | undefined>(nav[0]);

	const isExpandable = (item: NavItem) => item.type === 'threads';

	function isActive(href: string, exact: boolean): boolean {
		const path = $page.url.pathname;
		return exact ? path === href : path.startsWith(href);
	}

	function isParentActive(item: NavItem): boolean {
		return isActive(item.href, item.exact);
	}

	function handleNavClick(item: NavItem, e: MouseEvent) {
		if (isExpandable(item)) {
			if (expandedSection === item.href) {
				e.preventDefault();
				expandedSection = null;
				return;
			}
			expandedSection = item.href;
		}
		// Leaf items: do NOT collapse an open section here. Tearing down the
		// expanded chat-history (a transition:slide subtree) synchronously inside
		// the tap competed with the <a href> navigation on touch, so the first tap
		// only collapsed and a second was needed to navigate. Let the native link
		// navigate; the open section is harmless and closes on its own next toggle.
		sidebarOpen = false;
	}

	function selectThread(id: string) {
		sidebarOpen = false;
		// Slice B3: opening an escalated thread clears its unread badge. Sequence
		// the mark-read PATCH BEFORE the post-resume loadThreads so the reload
		// doesn't re-fetch a still-unread row and flicker the badge back.
		const read = markThreadRead(id);
		void goto('/app')
			.then(() => resumeThread(id))
			.then(() => read)
			.then(() => { void loadThreads(); });
	}

	function formatThreadDate(dateStr: string): string {
		const parsed = new Date(dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z');
		if (Number.isNaN(parsed.getTime())) return dateStr;
		const now = new Date();
		const isToday = parsed.toDateString() === now.toDateString();
		const yesterday = new Date(now);
		yesterday.setDate(yesterday.getDate() - 1);
		const isYesterday = parsed.toDateString() === yesterday.toDateString();
		const lang = getLocale();
		const locale = lang === 'de' ? 'de-DE' : 'en-US';
		const time = parsed.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
		if (isToday) return time;
		if (isYesterday) return `${lang === 'de' ? 'Gestern' : 'Yesterday'} ${time}`;
		return parsed.toLocaleDateString(locale, { day: 'numeric', month: 'short' }) + ` ${time}`;
	}

	// When the active thread is archived/deleted, navigate to new chat
	onActiveThreadRemoved(() => {
		newChat();
		void loadThreads();
		goto('/app');
	});

	// Auto-refresh threads when tab regains focus (cross-device sync)
	let stopVisibilityRefresh: (() => void) | undefined;
	let stopActiveRunsPoll: (() => void) | undefined;

	// Auto-expand section matching current route on mount.
	onMount(() => {
		void loadThreads();
		stopVisibilityRefresh = startVisibilityRefresh();
		stopActiveRunsPoll = startActiveRunsPoll();
		const match = nav.find(item => isExpandable(item) && isParentActive(item));
		if (match) {
			expandedSection = match.href;
		}
		// Restore pin preference. Default = unpinned (collapsed icon-rail) so
		// new users see the maximum-content layout.
		try {
			railPinned = localStorage.getItem('lynox-rail-pinned') === '1';
		} catch { /* localStorage may be blocked; collapsed default is fine */ }
		railMq = window.matchMedia('(min-width: 768px)');
		isDesktop = railMq.matches;
		railMq.addEventListener('change', onRailMq);
	});

	function togglePin(): void {
		railPinned = !railPinned;
		// Cancel any pending leave-grace; pin makes its outcome irrelevant
		// and a stray fire could flip railHovered after pinning.
		if (railLeaveTimer) { clearTimeout(railLeaveTimer); railLeaveTimer = null; }
		try { localStorage.setItem('lynox-rail-pinned', railPinned ? '1' : '0'); } catch { /* see onMount */ }
	}

	function onRailEnter(): void {
		// Ignore the synthetic `mouseenter` iOS Safari fires on a touch tap. On a
		// touch device the rail-hover concept doesn't apply (the mobile drawer is
		// full-width), and a stray hover flips railExpanded → the chat-history
		// slides open UNDER the finger and shoves the tapped nav item away, so the
		// first tap doesn't navigate (the double-tap bug). Only real pointers hover.
		if (typeof window !== 'undefined' &&
			!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
		if (railLeaveTimer) { clearTimeout(railLeaveTimer); railLeaveTimer = null; }
		railHovered = true;
	}

	function onRailLeave(): void {
		// Small grace period so a quick mouse jitter near the rail edge or a
		// dive into the sub-nav popover doesn't snap the rail closed mid-click.
		if (railLeaveTimer) clearTimeout(railLeaveTimer);
		railLeaveTimer = setTimeout(() => { railHovered = false; railLeaveTimer = null; }, 150);
	}

	onDestroy(() => {
		stopVisibilityRefresh?.();
		stopActiveRunsPoll?.();
		if (railLeaveTimer) { clearTimeout(railLeaveTimer); railLeaveTimer = null; }
		railMq?.removeEventListener('change', onRailMq);
	});

	/** Accessible label for the live-run status dot (no text in the row — the
	 * dot + aria-label carry the meaning so the cramped row stays scannable). */
	function runStatusLabel(status: 'running' | 'awaiting_input' | 'interrupted'): string {
		if (status === 'awaiting_input') return t('threads.run_awaiting');
		if (status === 'interrupted') return t('threads.run_interrupted');
		return t('threads.run_running');
	}

	$effect(() => {
		function handleEscape(e: KeyboardEvent) {
			if (e.key === 'Escape' && sidebarOpen) sidebarOpen = false;
		}
		window.addEventListener('keydown', handleEscape);
		return () => window.removeEventListener('keydown', handleEscape);
	});
</script>

<div class="fixed inset-0 flex flex-col overflow-hidden bg-bg" style="padding-top: env(safe-area-inset-top);">
	<!-- Body: sidebar (full height) + right column -->
	<div class="flex flex-1 min-h-0 overflow-hidden">
		<!-- Mobile overlay -->
		{#if sidebarOpen}
			<button
				class="fixed inset-0 z-30 bg-bg-overlay/80 md:hidden backdrop-blur-sm"
				onclick={() => (sidebarOpen = false)}
				aria-label="Close menu"
			></button>
		{/if}

		<!-- Left Sidebar — variant B icon-rail.
			Mobile: full 64-wide drawer (sidebarOpen toggle), unchanged from before.
			≥ md: 56px collapsed, 240px expanded on hover. Pin button locks open. -->
		<nav
			onmouseenter={onRailEnter}
			onmouseleave={onRailLeave}
			class="fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-bg-subtle transition-[width,transform] duration-150 md:static md:translate-x-0
			{sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
			{railExpanded ? 'md:w-60' : 'md:w-14'}"
			style="padding-top: calc(env(safe-area-inset-top, 0px) + 0.75rem);"
		>
			<!-- New Chat -->
			<div class="px-2 mb-2">
				<button
					onclick={() => { newChat(); void loadThreads(); sidebarOpen = false; if ($page.url.pathname !== '/app') goto('/app'); }}
					class="w-full rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover transition-all flex items-center gap-2 {railExpanded ? 'justify-start' : 'md:justify-center md:px-2'}"
					title={t('nav.new_chat')}
					aria-label={t('nav.new_chat')}
				>
					<Icon name="plus" size="sm" />
					<span class="{railExpanded ? '' : 'md:hidden'}">{t('nav.new_chat')}</span>
				</button>
			</div>

			<!-- Parent nav item markup, shared by both nav groups. Extracted into a
				 snippet so the Chat/threads group and the pinned leaf group don't
				 duplicate the active-state / collapse-aware <a> classes. -->
			{#snippet navParent(item: NavItem)}
				<a
					href={item.href}
					onclick={(e) => handleNavClick(item, e)}
					title={t(item.labelKey)}
					class="flex items-center gap-2.5 rounded-[var(--radius-sm)] py-2 text-sm transition-all
					{railExpanded ? 'px-3' : 'md:justify-center md:px-2 px-3'}
					{isParentActive(item)
						? 'bg-accent/10 text-accent-text border-l-2 border-accent'
						: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
				>
					<Icon name={item.icon} size="sm" />
					<div class="flex-1 min-w-0 {railExpanded ? '' : 'md:hidden'}">
						<span>{t(item.labelKey)}</span>
					</div>
					{#if isExpandable(item) && navExpanded}
						<Icon
							name="chevron_right"
							size="xs"
							class="text-text-subtle transition-transform duration-150 {expandedSection === item.href ? 'rotate-90' : ''}"
						/>
					{/if}
				</a>
			{/snippet}

			<!-- Chat + threads group. Grows to fill all leftover vertical space
				 ONLY when the chat section is open on the expanded rail; otherwise
				 it stays tight (shrink-0) so the pinned group sits flush below.
				 min-h-0 on every ancestor in this flex chain so the inner thread
				 <ul> scrolls instead of pushing the pinned group off-screen. -->
			{#if chatItem}
				<div class="px-2 flex flex-col min-h-0 {navExpanded && expandedSection === chatItem.href ? 'flex-1' : 'shrink-0'}">
					<!-- Parent nav item -->
					{@render navParent(chatItem)}

					<!-- Sub-items: threads list (Chat only). Only when expanded —
						 collapsed rail hides the threads dropdown to save space. -->
					{#if navExpanded && expandedSection === chatItem.href && chatItem.type === 'threads'}
						<div transition:slide={{ duration: 150 }} class="flex-1 flex flex-col min-h-0">
							{#if getThreads().length > 0}
								<!-- Thread search: client-side filter on title. Tiny enough to drop
									 into the existing sidebar without a sub-component. -->
								<div class="mx-1 mt-2 mb-1 shrink-0">
									<input
										type="search"
										bind:value={threadQuery}
										placeholder={t('threads.search_placeholder')}
										class="w-full px-2 py-1 text-[12px] bg-bg-subtle border border-border rounded-[var(--radius-sm)] text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
										aria-label={t('threads.search_placeholder')}
									/>
								</div>
								{@const visibleThreads = filteredThreads()}
								{#if visibleThreads.length === 0}
									<p class="px-2 py-2 text-[11px] text-text-subtle">{t('threads.search_empty')}</p>
								{:else}
								<ul class="mt-1 flex-1 space-y-0.5 min-h-0 overflow-y-auto scrollbar-none" aria-label={t('threads.recent')}>
									{#each visibleThreads as thread (thread.id)}
											{@const isThreadActive = getSessionId() === thread.id}
											{@const runStatus = getRunStatus(thread.id)}
											<li class="relative overflow-hidden rounded-[var(--radius-sm)]">
												<!-- Swipe archive action (mobile). Icon only — the previous full
													 "Archivieren" label clipped to "chivieren" at narrow widths. -->
												<button
													onclick={(e) => { e.stopPropagation(); void archiveThread(thread.id, getSessionId()); closeSwipe(); }}
													class="absolute inset-y-0 right-0 z-0 flex items-center px-4 bg-danger/20 text-danger"
													aria-label={t('threads.archive')}
													title={t('threads.archive')}
												>
													<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
														<path stroke-linecap="round" stroke-linejoin="round" d="m20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0-3-3m3 3 3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" />
													</svg>
												</button>
												<div
													role="group"
													data-swipe-thread={thread.id}
													ontouchstart={(e) => onSwipeStart(e, thread.id)}
													ontouchmove={onSwipeMove}
													ontouchend={() => onSwipeEnd(thread.id)}
													class="group relative z-10 flex items-center bg-bg-subtle transition-transform duration-150
													{isThreadActive
														? 'bg-accent/10 text-accent-text'
														: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
												>
													<!-- Live-run status dot. No text — space is tight, so the
														 pulse + aria-label carry the meaning. Leading slot so it
														 aligns vertically across rows and is scannable at a glance;
														 renders nothing when the thread has no active run (no
														 layout shift for the common case). running = accent pulse,
														 awaiting_input = amber ping (needs you), interrupted =
														 steady danger (Retry). -->
													{#if runStatus}
														<span
															class="shrink-0 pl-2 flex items-center"
															role="status"
															aria-label={runStatusLabel(runStatus)}
															title={runStatusLabel(runStatus)}
															data-run-status={runStatus}
														>
															<span class="relative inline-flex h-2 w-2">
																{#if runStatus === 'awaiting_input'}
																	<span class="absolute inline-flex h-full w-full rounded-full bg-warning/70 opacity-75 motion-safe:animate-ping"></span>
																	<span class="relative inline-flex h-2 w-2 rounded-full bg-warning"></span>
																{:else if runStatus === 'interrupted'}
																	<span class="relative inline-flex h-2 w-2 rounded-full bg-danger"></span>
																{:else}
																	<span class="relative inline-flex h-2 w-2 rounded-full bg-accent motion-safe:animate-pulse"></span>
																{/if}
															</span>
														</span>
													{/if}
													{#if renamingThreadId === thread.id}
													<input
														type="text"
														bind:value={renameValue}
														onblur={() => commitRename(thread.id)}
														onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') commitRename(thread.id); if (e.key === 'Escape') cancelRename(); }}
														class="flex-1 px-2 py-1.5 text-sm bg-bg border border-accent/40 rounded-[var(--radius-sm)] outline-none text-text"
														use:focusOnMount
													/>
												{:else}
													<button
														onclick={() => { if (swipedThreadId) { closeSwipe(); return; } selectThread(thread.id); }}
														ondblclick={() => startRename(thread.id, thread.title || formatThreadDate(thread.created_at))}
														class="flex-1 text-left px-2 py-2 text-sm truncate"
													>
														{#if thread.is_unread}<span class="inline-block h-1.5 w-1.5 rounded-full bg-accent mr-1.5 align-middle" aria-label={t('threads.unread')} title={t('threads.unread')}></span>{/if}
														{#if hasVoicePrefix(thread.title)}
															<svg xmlns="http://www.w3.org/2000/svg" class="inline-block h-3 w-3 mr-1 -mt-0.5 text-current opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d={MIC_SVG_PATH} /></svg>{stripVoicePrefix(thread.title!)}
														{:else}
															{thread.title || formatThreadDate(thread.created_at)}
														{/if}
													</button>
												{/if}
													{#if thread.is_favorite || thread.skip_extraction}
														<span class="shrink-0 pr-1 group-hover:hidden flex items-center gap-0.5">
															{#if thread.skip_extraction}<svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 text-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-label={t('threads.private')}><title>{t('threads.private')}</title><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" /></svg>{/if}
															{#if thread.is_favorite}<span class="text-accent text-xs">&#9733;</span>{/if}
														</span>
													{:else}
														<span class="text-[10px] text-text-subtle shrink-0 pr-1 group-hover:hidden tabular-nums">
															{timeAgo(thread.updated_at)}
														</span>
													{/if}
													<!-- Per-thread kebab. Tapping captures the button's viewport rect so
														 the shared menu (rendered at the nav root) can position itself
														 with `position: fixed` and escape the `<li overflow-hidden>` +
														 `<ul overflow-y-auto>` clips that would otherwise hide the popover. -->
													<button
														type="button"
														onclick={(e: MouseEvent) => toggleMenu(thread.id, e)}
														class="flex items-center justify-center h-7 w-7 mr-1 rounded text-text-subtle hover:text-text hover:bg-text-muted/10 transition-colors pointer-coarse:h-9 pointer-coarse:w-9 shrink-0"
														aria-label={t('threads.actions_menu')}
														aria-expanded={openMenuId === thread.id}
														aria-haspopup="menu"
													>
														<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
															<path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
														</svg>
													</button>
												</div>
											</li>
										{/each}
									</ul>
									{/if}
								{/if}
							</div>
						{/if}
					</div>
				{/if}

				<!-- Other nav items (Inbox/Activity/Automation/Intelligence/Artifacts).
					 Pinned RIGHT BELOW the Chat section — shrink-0 so they keep
					 their natural height and never get compressed by the growing
					 Chat/threads group above. All leaf items: only the parent <a>. -->
				<ul class="space-y-0.5 px-2 shrink-0">
					{#each nav.slice(1) as item}
						<li>
							{@render navParent(item)}
						</li>
					{/each}
				</ul>

			<!-- Bottom: Settings + pin/unpin + sign-out all on ONE row, anchored
				 to the actual bottom via `mt-auto`. 2026-05-25 final shape:
				 - Single-row layout per pre-#579 (user reverted the two-row
				   split — both visual rows + flex-1 spacer caused chat-history
				   expansion to flicker because spacer competed with the
				   chat-section's own flex-1).
				 - `mt-auto` pushes the row down WITHOUT claiming flex-1 grow,
				   so when chat-history IS expanded its flex-1 takes the space
				   uncontested.
				 - We deliberately do NOT pad to `env(safe-area-inset-bottom)` —
				   it produced ~34px of empty space on iPhone below the row that
				   the user perceived as a layout bug. The Home Indicator zone
				   is reserved for system gestures but not off-limits. -->
			<div class="mt-auto border-t border-border px-2 py-2">
				<div class="flex items-center gap-1 {railExpanded ? '' : 'md:flex-col md:gap-0.5'}">
					<a
						href="/app/settings"
						onclick={() => { sidebarOpen = false; expandedSection = null; }}
						title={t('nav.settings')}
						class="flex flex-1 items-center gap-2.5 rounded-[var(--radius-sm)] h-11 text-sm transition-all
						{railExpanded ? 'px-3' : 'md:flex-none md:justify-center md:px-2 md:w-11 px-3'}
						{isActive('/app/settings', false)
							? 'bg-accent/10 text-accent-text border-l-2 border-accent'
							: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
					>
						<Icon name="settings" size="sm" />
						<span class="{railExpanded ? '' : 'md:hidden'}">{t('nav.settings')}</span>
					</a>
					<button
						type="button"
						onclick={togglePin}
						title={railPinned ? t('nav.rail_unpin') : t('nav.rail_pin')}
						aria-label={railPinned ? t('nav.rail_unpin') : t('nav.rail_pin')}
						aria-pressed={railPinned}
						class="hidden md:flex items-center justify-center h-11 w-11 rounded-[var(--radius-sm)] {railPinned ? 'text-accent-text bg-accent/10' : 'text-text-subtle hover:text-text hover:bg-bg-muted'} transition-colors"
					>
						<Icon name={railPinned ? 'chevron_double_left' : 'chevron_double_right'} size="sm" />
					</button>
					<a
						href="/logout"
						data-sveltekit-preload-data="off"
						data-sveltekit-reload
						class="flex items-center justify-center h-11 w-11 rounded-[var(--radius-sm)] text-text-subtle hover:text-text hover:bg-bg-muted transition-colors"
						aria-label={t('nav.logout')}
						title={t('nav.logout')}
					>
						<Icon name="logout" size="sm" />
					</a>
				</div>
			</div>
		</nav>

		<!-- Right column: header + main content -->
		<div class="flex-1 min-w-0 flex flex-col overflow-hidden">
			<!-- Header (above chat area) -->
			<header class="flex items-center justify-between h-12 px-4 border-b border-border bg-bg shrink-0">
				<!-- Left: hamburger (mobile) + logo -->
				<div class="flex items-center gap-3">
					<button onclick={() => { sidebarOpen = true; langDropdownOpen = false; }} class="md:hidden h-10 w-10 flex items-center justify-center rounded text-text-subtle hover:text-text hover:bg-bg-muted transition-colors -ml-2" aria-label="Open menu">
						<Icon name="hamburger" size="md" />
					</button>
					<!-- PRD-LIGHT-MODE PR 4 — two static <img>, CSS visibility-switch
					     by [data-theme]. Avoids SSR/hydrate flicker that any reactive
					     getResolvedTheme() lookup would introduce on the header. -->
					<img src="/logo-brand-dark.svg" alt="lynox" class="h-5 w-auto logo-brand-dark" />
					<img src="/logo-brand-light.svg" alt="lynox" class="h-5 w-auto logo-brand-light" />
				</div>

				<!-- Center: active session title (editable) on chat, else Cmd+K hint -->
				{#snippet cmdkHint()}
					<button onclick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))} aria-label={t('cmd.placeholder')} class="hidden md:flex items-center gap-2 text-xs text-text-subtle hover:text-text transition-colors rounded-[var(--radius-md)] border border-border px-3 py-1.5">
						<Icon name="search" size="sm" />
						<span>{t('cmd.placeholder')}</span>
						<kbd class="text-[10px] font-mono bg-bg-muted px-1 py-0.5 rounded">⌘K</kbd>
					</button>
				{/snippet}
				{#if isActive('/app', true) && getSessionId()}
					{@const ct = getThreads().find((thr) => thr.id === getSessionId())}
					{#if ct && headerRenaming}
						<input
							type="text"
							bind:value={headerRenameValue}
							onblur={() => { void commitHeaderRename(); }}
							onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { void commitHeaderRename(); } if (e.key === 'Escape') cancelHeaderRename(); }}
							class="hidden md:block w-72 max-w-[40vw] px-2 py-1 text-sm bg-bg border border-accent/40 rounded-[var(--radius-md)] outline-none text-text"
							aria-label={t('threads.rename')}
							use:focusOnMount
						/>
					{:else if ct}
						<button
							onclick={startHeaderRename}
							class="group hidden md:flex items-center gap-1.5 max-w-[40vw] text-sm text-text-subtle hover:text-text transition-colors rounded-[var(--radius-md)] px-2 py-1 hover:bg-bg-muted"
							title={t('threads.rename')}
							aria-label={t('threads.rename')}
						>
							<span class="truncate">{ct.title || formatThreadDate(ct.created_at)}</span>
							<Icon name="pencil" size="xs" class="opacity-0 group-hover:opacity-70" />
						</button>
					{:else}
						{@render cmdkHint()}
					{/if}
				{:else}
					{@render cmdkHint()}
				{/if}

				<!-- Right: private toggle + locale dropdown + sign out -->
				<div class="flex items-center gap-1">
					<!-- Private mode toggle (chat page only) -->
					{#if isActive('/app', true) && getSessionId()}
						<button
							onclick={() => void toggleSkipExtraction()}
							class="flex items-center gap-1.5 text-xs transition-colors min-h-[2.5rem] px-2 py-2 rounded hover:bg-bg-muted {getSkipExtraction() ? 'text-warning' : 'text-text-subtle hover:text-text'}"
							aria-label={getSkipExtraction() ? t('threads.private_on') : t('threads.private_off')}
							title={getSkipExtraction() ? t('threads.private_on') : t('threads.private_off')}
						>
							{#if getSkipExtraction()}
								<Icon name="eye_off" size="xs" />
								<span class="hidden md:inline font-mono">{t('threads.private')}</span>
							{:else}
								<Icon name="eye" size="xs" />
							{/if}
						</button>
					{/if}
					<!-- Language dropdown -->
					<div class="relative">
						<button
							onclick={() => (langDropdownOpen = !langDropdownOpen)}
							class="flex items-center gap-1 text-xs font-mono text-text-subtle hover:text-text transition-colors min-h-[2.5rem] min-w-[2.5rem] justify-center px-2 py-2 rounded hover:bg-bg-muted"
							aria-label="Switch language"
							aria-expanded={langDropdownOpen}
						>
							{getLocale().toUpperCase()}
							<Icon name="chevron_down" size="xs" />
						</button>
						{#if langDropdownOpen}
							<!-- backdrop to close -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="fixed inset-0 z-50" onclick={() => (langDropdownOpen = false)} onkeydown={() => {}}></div>
							<div class="absolute right-0 top-full mt-1 z-50 min-w-[8rem] rounded-[var(--radius-md)] border border-border bg-bg shadow-lg py-1">
								<button
									onclick={() => { setLocale('de'); langDropdownOpen = false; }}
									class="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-left transition-colors {getLocale() === 'de' ? 'text-accent-text bg-accent/10' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
								>
									<span class="font-mono w-5">DE</span>
									<span>Deutsch</span>
								</button>
								<button
									onclick={() => { setLocale('en'); langDropdownOpen = false; }}
									class="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-left transition-colors {getLocale() === 'en' ? 'text-accent-text bg-accent/10' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
								>
									<span class="font-mono w-5">EN</span>
									<span>English</span>
								</button>
							</div>
						{/if}
					</div>
					{#if userSlot}
						{@render userSlot()}
					{/if}
					<!-- Thread actions kebab (chat view only). Opens the same shared menu
						 the sidebar's per-row kebabs use, but anchored to this header
						 button — convenient when the user is reading a thread and wants
						 to rename/archive/export without scrolling the sidebar.
						 Sign out moved to the sidebar bottom next to Settings. -->
					{#if isActive('/app', true) && getSessionId()}
						{@const sid = getSessionId()}
						<button
							type="button"
							onclick={(e: MouseEvent) => { if (sid) toggleMenu(sid, e); }}
							class="flex items-center justify-center text-text-subtle hover:text-text transition-colors min-h-[2.5rem] min-w-[2.5rem] p-2 rounded hover:bg-bg-muted"
							aria-label={t('threads.actions_menu')}
							aria-expanded={openMenuId !== null && openMenuId === sid}
							aria-haspopup="menu"
						>
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
							</svg>
						</button>
					{/if}
				</div>
			</header>

			<!-- HN-launch public-demo banner (engine.lynox.cloud only; public-repo-guard:allow public demo host
				controlled by LYNOX_PUBLIC_DEMO env on the engine). Sits ABOVE
				SetupBanner so the "shared instance, no real data" warning is the
				very first thing visible — beats the API-key wizard prompt to the
				visual hierarchy. -->
			<PublicDemoBanner />

			<!-- Setup warnings -->
			<SetupBanner />

			<!-- Session-expired banner — fires when any /api/* 401s. Common
				cause is Safari PWA cookie eviction; engine itself is fine. -->
			{#if isSessionExpired()}
				<div class="border-b border-warning bg-warning-subtle px-4 py-2.5 flex items-center justify-between gap-3 flex-wrap">
					<div class="text-[12px] text-warning">
						<strong>{t('session.expired_title')}</strong>
						<span class="ml-2 text-text-muted">{t('session.expired_hint')}</span>
					</div>
					<div class="flex items-center gap-2">
						<button
							type="button"
							onclick={() => clearSessionExpired()}
							class="text-[11px] text-text-subtle hover:text-text px-2 py-1"
						>{t('session.dismiss')}</button>
						<a
							href="/login"
							class="rounded-[var(--radius-sm)] bg-accent text-accent-fg px-3 py-1.5 text-[11px] hover:opacity-90"
						>{t('session.relogin')}</a>
					</div>
				</div>
			{/if}

			<!-- Main Content -->
			<main class="flex-1 min-w-0 flex flex-col overflow-hidden">
				<div class="flex-1 min-h-0 flex overflow-hidden">
					<div class="flex-1 min-w-0 overflow-y-auto scrollbar-none">
						{@render children()}
					</div>

					<!-- Context Panel (right sidebar). Default-off while reworked; library consumers can opt in via configure({ contextPanelEnabled: true }). -->
					{#if getContextPanelEnabled()}
						<ContextPanel />
					{/if}
				</div>
			</main>
		</div>
	</div>

	<!-- Status Bar -->
	<StatusBar />

	<!-- Command Palette -->
	<CommandPalette />

	<!-- Shared thread-action menu. Rendered at the root so `position: fixed`
		 escapes the `<li overflow-hidden>` + `<ul overflow-y-auto>` clips that
		 would otherwise hide the popover. Positioned via the kebab's
		 captured DOMRect — see `toggleMenu`. -->
	{#if openMenuId !== null && menuAnchor !== null}
		{@const activeThread = getThreads().find((t) => t.id === openMenuId)}
		{#if activeThread}
			<button
				type="button"
				class="fixed inset-0 z-[60] cursor-default bg-transparent"
				onclick={closeMenu}
				aria-label={t('threads.menu_close')}
			></button>
			<!-- 200px menu width; clamp left to viewport so a kebab at the right
				 edge doesn't overflow off-screen on narrow viewports. -->
			<ul
				role="menu"
				class="fixed z-[70] min-w-[200px] rounded-[var(--radius-md)] border border-border bg-bg shadow-lg overflow-hidden"
				style="top: {Math.min(menuAnchor.bottom + 4, window.innerHeight - 240)}px; left: {Math.max(8, Math.min(menuAnchor.right - 200, window.innerWidth - 208))}px"
			>
				<li role="none">
					<button type="button" role="menuitem"
						onclick={(e: MouseEvent) => { e.stopPropagation(); const id = activeThread.id; const title = activeThread.title || formatThreadDate(activeThread.created_at); closeMenu(); startRename(id, title); }}
						class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[44px]"
					>{t('threads.rename')}</button>
				</li>
				<li role="none">
					<button type="button" role="menuitem"
						onclick={(e: MouseEvent) => { e.stopPropagation(); const id = activeThread.id; closeMenu(); void toggleFavorite(id); }}
						class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[44px]"
					>{activeThread.is_favorite ? t('threads.unfavorite') : t('threads.favorite')}</button>
				</li>
				<li role="none">
					<button type="button" role="menuitem"
						onclick={(e: MouseEvent) => { e.stopPropagation(); const id = activeThread.id; closeMenu(); void archiveThread(id, getSessionId()); }}
						class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[44px]"
					>{t('threads.archive')}</button>
				</li>
				<li role="none">
					<button type="button" role="menuitem"
						onclick={(e: MouseEvent) => { e.stopPropagation(); const id = activeThread.id; const title = activeThread.title ?? null; closeMenu(); void exportThread(id, title); }}
						class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[44px]"
					>{t('threads.export')}</button>
				</li>
				<li role="none">
					<button type="button" role="menuitem"
						onclick={(e: MouseEvent) => { e.stopPropagation(); const id = activeThread.id; const title = activeThread.title ?? null; closeMenu(); void exportThreadJson(id, title); }}
						class="block w-full px-3 py-2 text-left text-[12px] text-text-muted hover:bg-bg-subtle hover:text-text min-h-[44px]"
					>{t('threads.export_json')}</button>
				</li>
				<li role="none">
					<button type="button" role="menuitem"
						onclick={(e: MouseEvent) => { e.stopPropagation(); const id = activeThread.id; closeMenu(); void confirmDelete(id); }}
						class="block w-full px-3 py-2 text-left text-[12px] text-danger hover:bg-danger/10 min-h-[44px]"
					>{t('threads.delete')}</button>
				</li>
			</ul>
		{/if}
	{/if}
</div>

<style>
	/* PRD-LIGHT-MODE PR 4 — Header logo theme switch.
	   The dark variant has white "eyes" on the brand-violet circle for crisp
	   contrast on the dark canvas. The light variant uses brand indigo on
	   white. Both keep the brand-violet face circle. */
	:global([data-theme="dark"]) .logo-brand-light { display: none; }
	:global([data-theme="light"]) .logo-brand-dark { display: none; }
</style>
