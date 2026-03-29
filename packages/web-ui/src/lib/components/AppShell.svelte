<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { newChat } from '../stores/chat.svelte.js';
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

	const nav = [
		{ href: '/app', labelKey: 'nav.chat', exact: true, icon: 'chat', descKey: 'nav.desc.chat' },
		{ href: '/app/memory', labelKey: 'nav.knowledge', exact: false, icon: 'brain', descKey: 'nav.desc.knowledge' },
		{ href: '/app/graph', labelKey: 'nav.graph', exact: false, icon: 'graph', descKey: 'nav.desc.graph' },
		{ href: '/app/insights', labelKey: 'nav.insights', exact: false, icon: 'insights', descKey: 'nav.desc.insights' },
		{ href: '/app/contacts', labelKey: 'nav.contacts', exact: false, icon: 'contacts', descKey: 'nav.desc.contacts' },
		{ href: '/app/history', labelKey: 'nav.history', exact: false, icon: 'clock', descKey: 'nav.desc.history' },
		{ href: '/app/tasks', labelKey: 'nav.tasks', exact: false, icon: 'bolt', descKey: 'nav.desc.tasks' },
		{ href: '/app/files', labelKey: 'nav.files', exact: false, icon: 'files', descKey: 'nav.desc.files' },
	];

	function isActive(href: string, exact: boolean): boolean {
		const path = $page.url.pathname;
		return exact ? path === href : path.startsWith(href);
	}
</script>

<div class="fixed inset-0 flex flex-col overflow-hidden">
	<!-- Top Bar -->
	<header class="flex items-center justify-between h-12 px-4 border-b border-border bg-bg shrink-0">
		<!-- Left: hamburger (mobile) + logo -->
		<div class="flex items-center gap-3">
			<button onclick={() => (sidebarOpen = true)} class="md:hidden text-text-subtle hover:text-text" aria-label="Open menu">
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

	<!-- Body: sidebar + main + context panel -->
	<div class="flex flex-1 min-h-0 overflow-hidden">
		<!-- Mobile overlay -->
		{#if sidebarOpen}
			<button
				class="fixed inset-0 z-30 bg-black/60 md:hidden"
				onclick={() => (sidebarOpen = false)}
				aria-label="Close menu"
			></button>
		{/if}

		<!-- Left Sidebar -->
		<nav
			class="fixed inset-y-0 left-0 z-40 flex w-52 flex-col border-r border-border bg-bg-subtle pt-3 pb-3 transition-transform md:static md:translate-x-0
			{sidebarOpen ? 'translate-x-0' : '-translate-x-full'}"
		>
			<!-- New Chat -->
			<div class="px-3 mb-2">
				<button
					onclick={() => { newChat(); sidebarOpen = false; goto('/app'); }}
					class="w-full rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover transition-all text-left flex items-center gap-2"
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
						<path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
					</svg>
					{t('nav.new_chat')}
				</button>
			</div>

			<!-- Nav Items -->
			<ul class="flex-1 space-y-0.5 px-3">
				{#each nav as item}
					<li>
						<a
							href={item.href}
							onclick={() => (sidebarOpen = false)}
							class="flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-all
							{isActive(item.href, item.exact)
								? 'bg-accent/10 text-accent-text border-l-2 border-accent'
								: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
						>
							{#if item.icon === 'chat'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" /></svg>
							{:else if item.icon === 'brain'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" /></svg>
							{:else if item.icon === 'clock'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
							{:else if item.icon === 'bolt'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" /></svg>
							{:else if item.icon === 'graph'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" /></svg>
							{:else if item.icon === 'contacts'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" /></svg>
							{:else if item.icon === 'insights'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" /></svg>
							{:else if item.icon === 'files'}
								<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" /></svg>
							{/if}
							<div>
									<span>{t(item.labelKey)}</span>
									{#if item.descKey}
										<span class="block text-[10px] text-text-subtle font-normal tracking-normal">{t(item.descKey)}</span>
									{/if}
								</div>
						</a>
					</li>
				{/each}
			</ul>

			<!-- Bottom: Settings + User -->
			<div class="border-t border-border pt-2 mt-2 px-3 space-y-0.5">
				<a
					href="/app/settings"
					onclick={() => (sidebarOpen = false)}
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

	<!-- Status Bar -->
	<StatusBar />

	<!-- Command Palette -->
	<CommandPalette />
</div>
