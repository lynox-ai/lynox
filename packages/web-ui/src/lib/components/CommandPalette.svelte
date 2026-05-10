<script lang="ts">
	import { goto } from '$app/navigation';
	import { newChat } from '../stores/chat.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { onMount, onDestroy } from 'svelte';

	interface PaletteItem {
		id: string;
		label: string;
		group: string;
		action: () => void;
		keywords?: string;
	}

	let open = $state(false);
	let query = $state('');
	let selectedIdx = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);

	const items: PaletteItem[] = [
		{ id: 'new-chat', label: t('cmd.new_chat'), group: t('cmd.actions'), action: () => { newChat(); goto('/app'); }, keywords: 'new chat neu' },
		{ id: 'nav-chat', label: t('nav.chat'), group: t('cmd.nav'), action: () => goto('/app'), keywords: 'chat home' },
		{ id: 'nav-automation', label: t('nav.automation'), group: t('cmd.nav'), action: () => goto('/app/workflows'), keywords: 'workflows pipelines automation dag abläufe' },
		{ id: 'nav-intelligence', label: t('nav.intelligence'), group: t('cmd.nav'), action: () => goto('/app/knowledge'), keywords: 'intelligence dashboards reports knowledge memory wissen graph insights kpi' },
		{ id: 'nav-contacts', label: t('nav.contacts'), group: t('cmd.nav'), action: () => goto('/app/contacts'), keywords: 'contacts kontakte crm deals' },
		{ id: 'nav-artifacts', label: t('nav.artifacts'), group: t('cmd.nav'), action: () => goto('/app/artifacts'), keywords: 'artifacts dashboards diagrams files galerie' },
		{ id: 'nav-activity', label: t('nav.activity'), group: t('cmd.nav'), action: () => goto('/app/activity'), keywords: 'activity history tasks runs kosten aktivität' },
		{ id: 'nav-settings', label: t('nav.settings'), group: t('cmd.nav'), action: () => goto('/app/settings'), keywords: 'settings einstellungen config' },
		{ id: 'nav-keys', label: t('settings.keys'), group: t('cmd.nav'), action: () => goto('/app/settings/keys'), keywords: 'keys api schluessel' },
		{ id: 'nav-integrations', label: t('settings.integrations'), group: t('cmd.nav'), action: () => goto('/app/settings/integrations'), keywords: 'integrations google telegram tavily mail email imap smtp' },
		{ id: 'nav-config', label: t('settings.config'), group: t('cmd.nav'), action: () => goto('/app/settings/config'), keywords: 'config model effort thinking budget backup' },
	];

	const filtered = $derived(
		query.trim()
			? items.filter((item) => {
					const q = query.toLowerCase();
					return item.label.toLowerCase().includes(q) ||
						(item.keywords?.toLowerCase().includes(q) ?? false);
				})
			: items
	);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIdx = Math.min(selectedIdx + 1, filtered.length - 1);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIdx = Math.max(selectedIdx - 1, 0);
		} else if (e.key === 'Enter' && filtered[selectedIdx]) {
			e.preventDefault();
			execute(filtered[selectedIdx]!);
		} else if (e.key === 'Escape') {
			open = false;
		}
	}

	function execute(item: PaletteItem) {
		open = false;
		query = '';
		item.action();
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
			e.preventDefault();
			open = !open;
			if (open) {
				query = '';
				selectedIdx = 0;
				requestAnimationFrame(() => inputEl?.focus());
			}
		}
	}

	onMount(() => {
		document.addEventListener('keydown', handleGlobalKeydown);
	});
	onDestroy(() => {
		document.removeEventListener('keydown', handleGlobalKeydown);
	});

	$effect(() => {
		if (filtered.length > 0 && selectedIdx >= filtered.length) {
			selectedIdx = 0;
		}
	});
</script>

{#if open}
	<!-- Backdrop -->
	<button class="fixed inset-0 z-50 bg-black/60" onclick={() => (open = false)} aria-label="Close"></button>

	<!-- Palette -->
	<div class="fixed inset-x-2 md:inset-x-4 z-50 mx-auto max-w-lg rounded-[var(--radius-lg)] border border-border bg-bg shadow-2xl overflow-hidden" style="top: calc(1rem + env(safe-area-inset-top, 0px));">
		<!-- Input -->
		<div class="flex items-center gap-3 border-b border-border px-4 py-3">
			<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 text-text-subtle shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
			</svg>
			<input
				bind:this={inputEl}
				bind:value={query}
				onkeydown={handleKeydown}
				placeholder={t('cmd.placeholder')}
				class="flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-subtle"
			/>
			<kbd class="text-[10px] font-mono text-text-subtle bg-bg-muted px-1.5 py-0.5 rounded">ESC</kbd>
		</div>

		<!-- Results -->
		<div class="max-h-72 overflow-y-auto py-2">
			{#if filtered.length === 0}
				<p class="px-4 py-3 text-sm text-text-subtle">{t('cmd.no_results')}</p>
			{:else}
				{@const groups = [...new Set(filtered.map((i) => i.group))]}
				{#each groups as group}
					<p class="px-4 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-text-subtle">{group}</p>
					{#each filtered.filter((i) => i.group === group) as item, i}
						{@const globalIdx = filtered.indexOf(item)}
						<button
							onclick={() => execute(item)}
							onmouseenter={() => (selectedIdx = globalIdx)}
							class="w-full px-4 py-2 text-sm text-left transition-colors
							{globalIdx === selectedIdx ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text'}"
						>
							{item.label}
						</button>
					{/each}
				{/each}
			{/if}
		</div>
	</div>
{/if}
