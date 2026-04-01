<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { newChat, resumeThread, getSessionId } from '../stores/chat.svelte.js';
	import { loadThreads, getThreads, archiveThread, toggleFavorite } from '../stores/threads.svelte.js';
	import { t, getLocale, setLocale } from '../i18n.svelte.js';
	import StatusBar from './StatusBar.svelte';
	import ContextPanel from './ContextPanel.svelte';
	import CommandPalette from './CommandPalette.svelte';
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

	interface NavChild {
		href: string;
		labelKey: string;
	}

	interface NavItem {
		href: string;
		labelKey: string;
		exact: boolean;
		icon: string;
		descKey?: string;
		children?: NavChild[];
		type?: 'threads';
	}

	const nav: NavItem[] = [
		{
			href: '/app', labelKey: 'nav.chat', exact: true, icon: 'chat',
			descKey: 'nav.desc.chat', type: 'threads',
		},
		{
			href: '/app/knowledge', labelKey: 'nav.knowledge', exact: false, icon: 'brain',
			descKey: 'nav.desc.knowledge',
			children: [
				{ href: '/app/knowledge', labelKey: 'hub.knowledge.wissen' },
				{ href: '/app/knowledge?tab=graph', labelKey: 'hub.knowledge.graph' },
				{ href: '/app/knowledge?tab=insights', labelKey: 'hub.knowledge.insights' },
			],
		},
		{
			href: '/app/contacts', labelKey: 'nav.contacts', exact: false, icon: 'contacts',
			descKey: 'nav.desc.contacts',
		},
		{
			href: '/app/artifacts', labelKey: 'nav.artifacts', exact: false, icon: 'artifacts',
			descKey: 'nav.desc.artifacts',
			children: [
				{ href: '/app/artifacts', labelKey: 'hub.artifacts.gallery' },
				{ href: '/app/artifacts?tab=files', labelKey: 'hub.artifacts.files' },
			],
		},
		{
			href: '/app/workflows', labelKey: 'nav.workflows', exact: false, icon: 'workflow',
			descKey: 'nav.desc.workflows',
			children: [
				{ href: '/app/workflows', labelKey: 'hub.workflow.list' },
				{ href: '/app/workflows?tab=analytics', labelKey: 'hub.workflow.analytics' },
			],
		},
		{
			href: '/app/activity', labelKey: 'nav.activity', exact: false, icon: 'clock',
			descKey: 'nav.desc.activity',
			children: [
				{ href: '/app/activity?tab=history', labelKey: 'hub.activity.history' },
				{ href: '/app/activity?tab=tasks', labelKey: 'hub.activity.tasks' },
				{ href: '/app/activity', labelKey: 'hub.activity.dashboard' },
			],
		},
	];

	const hasChildren = (item: NavItem) => item.children != null || item.type === 'threads';

	function isActive(href: string, exact: boolean): boolean {
		const path = $page.url.pathname;
		return exact ? path === href : path.startsWith(href);
	}

	function isSubActive(childHref: string): boolean {
		const url = $page.url;
		const child = new URL(childHref, url.origin);
		if (url.pathname !== child.pathname) return false;
		// Match query params (e.g. ?tab=graph)
		for (const [k, v] of child.searchParams) {
			if (url.searchParams.get(k) !== v) return false;
		}
		// If child has no params, only match when current URL also has no tab param
		if (!child.searchParams.has('tab') && url.searchParams.has('tab')) return false;
		return true;
	}

	function handleNavClick(item: NavItem, e: MouseEvent) {
		if (hasChildren(item)) {
			if (expandedSection === item.href) {
				e.preventDefault();
				expandedSection = null;
				return;
			}
			expandedSection = item.href;
		} else {
			expandedSection = null;
		}
		sidebarOpen = false;
	}

	function handleSubClick() {
		sidebarOpen = false;
	}

	function selectThread(id: string) {
		void resumeThread(id).then(() => { void loadThreads(); });
		sidebarOpen = false;
		void goto('/app');
	}

	function timeAgo(dateStr: string): string {
		const parsed = new Date(dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z');
		const diff = Date.now() - parsed.getTime();
		if (Number.isNaN(diff)) return '';
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return 'now';
		if (mins < 60) return `${mins}m`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}

	// Auto-expand section matching current route on mount
	onMount(() => {
		void loadThreads();
		const path = $page.url.pathname;
		const match = nav.find(item => item.exact ? path === item.href : path.startsWith(item.href));
		if (match && hasChildren(match)) {
			expandedSection = match.href;
		}
	});

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
				class="fixed inset-0 z-30 bg-black/80 md:hidden backdrop-blur-sm"
				onclick={() => (sidebarOpen = false)}
				aria-label="Close menu"
			></button>
		{/if}

		<!-- Left Sidebar -->
		<nav
			class="fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-bg-subtle pb-3 transition-transform md:static md:w-52 md:translate-x-0
			{sidebarOpen ? 'translate-x-0' : '-translate-x-full'}"
			style="padding-top: calc(env(safe-area-inset-top, 0px) + 0.75rem);"
		>
			<!-- New Chat -->
			<div class="px-3 mb-2">
				<button
					onclick={() => { newChat(); void loadThreads(); sidebarOpen = false; goto('/app'); }}
					class="w-full rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover transition-all text-left flex items-center gap-2"
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
					</svg>
					{t('nav.new_chat')}
				</button>
			</div>

			<!-- Nav Items -->
			<ul class="flex-1 space-y-0.5 px-3 overflow-y-auto scrollbar-thin">
				{#each nav as item}
					<li>
						<!-- Parent nav item -->
						<a
							href={item.href}
							onclick={(e) => handleNavClick(item, e)}
							class="flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-all
							{isActive(item.href, item.exact)
								? 'bg-accent/10 text-accent-text border-l-2 border-accent'
								: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
						>
							{#if item.icon === 'chat'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" /></svg>
							{:else if item.icon === 'brain'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>
							{:else if item.icon === 'workflow'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6z" /><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 7.125h3M7.125 10.5v3" /></svg>
							{:else if item.icon === 'clock'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
							{:else if item.icon === 'contacts'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg>
							{:else if item.icon === 'artifacts'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" /></svg>
							{/if}
							<div class="flex-1 min-w-0">
								<span>{t(item.labelKey)}</span>
								{#if item.descKey}
									<span class="block text-xs text-text-subtle font-normal tracking-normal">{t(item.descKey)}</span>
								{/if}
							</div>
							{#if hasChildren(item)}
								<svg
									xmlns="http://www.w3.org/2000/svg"
									class="h-3 w-3 shrink-0 text-text-subtle transition-transform duration-150 {expandedSection === item.href ? 'rotate-90' : ''}"
									fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
								><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
							{/if}
						</a>

						<!-- Sub-items: threads for Chat, static links for hubs -->
						{#if expandedSection === item.href && item.type === 'threads'}
							<div transition:slide={{ duration: 150 }}>
								{#if getThreads().length > 0}
									<ul class="mt-1 ml-2 space-y-0.5 max-h-72 overflow-y-auto scrollbar-thin">
										{#each getThreads() as thread (thread.id)}
											{@const isThreadActive = getSessionId() === thread.id}
											<li class="relative overflow-hidden rounded-[var(--radius-sm)]">
												<!-- Swipe archive action (mobile) -->
												<button
													onclick={(e) => { e.stopPropagation(); void archiveThread(thread.id); closeSwipe(); }}
													class="absolute inset-y-0 right-0 z-0 flex items-center px-4 bg-danger/20 text-danger text-sm font-medium"
													aria-label={t('threads.archive')}
												>{t('threads.archive')}</button>
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
													<button
														onclick={() => { if (swipedThreadId) { closeSwipe(); return; } selectThread(thread.id); }}
														class="flex-1 text-left px-2.5 py-2 text-sm truncate"
													>
														{thread.title || t('threads.no_title')}
													</button>
													{#if thread.is_favorite}
														<span class="text-accent text-xs shrink-0 pr-1 group-hover:hidden">&#9733;</span>
													{:else}
														<span class="text-xs text-text-subtle shrink-0 pr-2 group-hover:hidden">
															{timeAgo(thread.updated_at)}
														</span>
													{/if}
													<button
														onclick={(e: MouseEvent) => { e.stopPropagation(); void toggleFavorite(thread.id); }}
														class="hidden group-hover:flex shrink-0 items-center justify-center h-5 w-5 mr-1 rounded text-text-subtle hover:text-accent hover:bg-accent/10 text-xs transition-colors"
														aria-label={thread.is_favorite ? t('threads.unfavorite') : t('threads.favorite')}
													>{thread.is_favorite ? '\u2605' : '\u2606'}</button>
													<button
														onclick={(e: MouseEvent) => { e.stopPropagation(); void archiveThread(thread.id); }}
														class="hidden group-hover:flex shrink-0 items-center justify-center h-5 w-5 mr-1 rounded text-text-subtle hover:text-danger hover:bg-danger/10 text-xs transition-colors"
														aria-label={t('threads.archive')}
													>&times;</button>
												</div>
											</li>
										{/each}
									</ul>
								{/if}
							</div>
						{:else if expandedSection === item.href && item.children}
							<ul transition:slide={{ duration: 150 }} class="mt-1 ml-5 space-y-0.5">
								{#each item.children as child}
									<li>
										<a
											href={child.href}
											onclick={handleSubClick}
											class="block px-2.5 py-1.5 text-xs rounded-[var(--radius-sm)] transition-all
											{isSubActive(child.href)
												? 'text-accent-text bg-accent/10'
												: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
										>
											{t(child.labelKey)}
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					</li>
				{/each}
			</ul>

			<!-- Bottom: Settings + User -->
			<div class="border-t border-border px-3 py-3" style="padding-bottom: env(safe-area-inset-bottom, 0.75rem);">
				<a
					href="/app/settings"
					onclick={() => { sidebarOpen = false; expandedSection = null; }}
					class="flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-all
					{isActive('/app/settings', false)
						? 'bg-accent/10 text-accent-text border-l-2 border-accent'
						: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" /><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
					{t('nav.settings')}
				</a>
			</div>
		</nav>

		<!-- Right column: header + main content -->
		<div class="flex-1 min-w-0 flex flex-col overflow-hidden">
			<!-- Header (above chat area) -->
			<header class="flex items-center justify-between h-12 px-4 border-b border-border bg-bg shrink-0">
				<!-- Left: hamburger (mobile) + logo -->
				<div class="flex items-center gap-3">
					<button onclick={() => (sidebarOpen = true)} class="md:hidden h-10 w-10 flex items-center justify-center rounded text-text-subtle hover:text-text hover:bg-bg-muted transition-colors -ml-2" aria-label="Open menu">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
							<path fill-rule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd" />
						</svg>
					</button>
					<img src="/logo-brand.svg" alt="lynox" class="h-5 w-auto" />
				</div>

				<!-- Center: Cmd+K hint -->
				<button onclick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))} aria-label={t('cmd.placeholder')} class="hidden md:flex items-center gap-2 text-xs text-text-subtle hover:text-text transition-colors rounded-[var(--radius-md)] border border-border px-3 py-1.5">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" /></svg>
					<span>{t('cmd.placeholder')}</span>
					<kbd class="text-[10px] font-mono bg-bg-muted px-1 py-0.5 rounded">⌘K</kbd>
				</button>

				<!-- Right: locale toggle + user -->
				<div class="flex items-center gap-3">
					<button
						onclick={() => setLocale(getLocale() === 'de' ? 'en' : 'de')}
						class="text-xs font-mono text-text-subtle hover:text-text transition-colors"
						aria-label="Switch language"
					>
						{getLocale() === 'de' ? 'EN' : 'DE'}
					</button>
					{#if userSlot}
						{@render userSlot()}
					{/if}
				</div>
			</header>

			<!-- Main Content -->
			<main class="flex-1 min-w-0 flex flex-col overflow-hidden">
				<div class="flex-1 min-h-0 flex overflow-hidden">
					<div class="flex-1 min-w-0 overflow-y-auto scrollbar-thin">
						{@render children()}
					</div>

					<!-- Context Panel (right sidebar, auto-fills from chat context) -->
					<ContextPanel />
				</div>
			</main>
		</div>
	</div>

	<!-- Status Bar -->
	<StatusBar />

	<!-- Command Palette -->
	<CommandPalette />
</div>
