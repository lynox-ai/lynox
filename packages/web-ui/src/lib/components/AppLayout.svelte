<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { newChat } from '../stores/chat.svelte.js';
	import { t, getLocale, setLocale } from '../i18n.svelte.js';
	import type { Snippet } from 'svelte';

	let { children, userSlot }: { children: Snippet; userSlot?: Snippet } = $props();

	let sidebarOpen = $state(false);

	const nav = [
		{ href: '/app', labelKey: 'nav.chat', exact: true },
		{ href: '/app/memory', labelKey: 'nav.knowledge', exact: false },
		{ href: '/app/history', labelKey: 'nav.history', exact: false },
		{ href: '/app/tasks', labelKey: 'nav.tasks', exact: false }
	];

	function isActive(href: string, exact: boolean): boolean {
		const path = $page.url.pathname;
		return exact ? path === href : path.startsWith(href);
	}
</script>

<div class="fixed inset-0 flex overflow-hidden">
	<!-- Mobile overlay -->
	{#if sidebarOpen}
		<button
			class="fixed inset-0 z-30 bg-black/60 md:hidden"
			onclick={() => (sidebarOpen = false)}
			aria-label="Close menu"
		></button>
	{/if}

	<!-- Sidebar -->
	<nav
		class="fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-border bg-bg-subtle px-4 py-5 transition-transform md:static md:translate-x-0
		{sidebarOpen ? 'translate-x-0' : '-translate-x-full'}"
	>
		<div class="mb-8 flex items-center justify-between">
			<img src="/logo-brand.svg" alt="lynox" class="h-7 w-full max-w-[180px]" />
			<button class="text-text-subtle hover:text-text md:hidden" onclick={() => (sidebarOpen = false)} aria-label="Close menu">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
				</svg>
			</button>
		</div>

		<button
			onclick={() => { newChat(); sidebarOpen = false; goto('/app'); }}
			class="mb-4 w-full rounded-[var(--radius-sm)] border border-border px-3 py-2 text-sm text-text-muted hover:text-text hover:border-border-hover transition-all text-left"
		>
			{t('nav.new_chat')}
		</button>

		<ul class="flex-1 space-y-0.5">
			{#each nav as item}
				<li>
					<a
						href={item.href}
						onclick={() => (sidebarOpen = false)}
						class="block rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-all
						{isActive(item.href, item.exact)
							? 'bg-accent/10 text-accent-text border-l-2 border-accent'
							: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
					>
						{t(item.labelKey)}
					</a>
				</li>
			{/each}
		</ul>

		<div class="border-t border-border pt-3 mt-3 space-y-1">
			<a
				href="/app/settings"
				onclick={() => (sidebarOpen = false)}
				class="block rounded-[var(--radius-sm)] px-3 py-2 text-sm transition-all
				{isActive('/app/settings', false)
					? 'bg-accent/10 text-accent-text border-l-2 border-accent'
					: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
			>
				{t('nav.settings')}
			</a>
			<div class="flex items-center justify-between px-3 pt-2">
				{#if userSlot}
					{@render userSlot()}
				{/if}
				<button
					onclick={() => setLocale(getLocale() === 'de' ? 'en' : 'de')}
					class="text-xs font-mono text-text-subtle hover:text-text transition-colors ml-auto"
					aria-label="Switch language"
				>
					{getLocale() === 'de' ? 'EN' : 'DE'}
				</button>
			</div>
		</div>
	</nav>

	<!-- Main content -->
	<main class="flex-1 min-w-0 flex flex-col overflow-hidden">
		<!-- Mobile header -->
		<div class="flex items-center gap-3 border-b border-border bg-bg-subtle px-4 py-3 md:hidden">
			<button onclick={() => (sidebarOpen = true)} aria-label="Open menu">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-text-subtle" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clip-rule="evenodd" />
				</svg>
			</button>
			<img src="/logo-brand.svg" alt="lynox" class="h-5 w-auto" />
		</div>

		<div class="flex-1 min-h-0">
			{@render children()}
		</div>
	</main>
</div>
