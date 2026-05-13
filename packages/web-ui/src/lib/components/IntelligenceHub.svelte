<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { t } from '../i18n.svelte.js';
	import ContactsView from './ContactsView.svelte';
	import KnowledgeGraphView from './KnowledgeGraphView.svelte';
	import MemoryInsightsView from './MemoryInsightsView.svelte';
	import MemoryView from './MemoryView.svelte';

	type Tab = 'wissen' | 'graph' | 'contacts' | 'insights';

	const tab = $derived<Tab>(((): Tab => {
		const p = $page.url.searchParams.get('tab');
		if (p === 'graph' || p === 'contacts' || p === 'insights') return p;
		return 'wissen';
	})());

	function setTab(next: Tab): void {
		const url = new URL($page.url);
		if (next === 'wissen') url.searchParams.delete('tab');
		else url.searchParams.set('tab', next);
		void goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
	}

	const tabs: ReadonlyArray<{ id: Tab; labelKey: string }> = [
		{ id: 'wissen', labelKey: 'hub.intelligence.wissen' },
		{ id: 'graph', labelKey: 'hub.intelligence.graph' },
		{ id: 'contacts', labelKey: 'hub.intelligence.contacts' },
		{ id: 'insights', labelKey: 'hub.intelligence.insights' },
	];
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center gap-1 px-4 sm:px-5 py-3 border-b border-border shrink-0 overflow-x-auto scrollbar-none">
		{#each tabs as t_item (t_item.id)}
			<button
				type="button"
				class="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors {tab === t_item.id ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
				onclick={() => setTab(t_item.id)}
			>{t(t_item.labelKey)}</button>
		{/each}
	</div>
	<div class="flex-1 overflow-y-auto">
		{#if tab === 'wissen'}
			<MemoryView />
		{:else if tab === 'graph'}
			<KnowledgeGraphView />
		{:else if tab === 'contacts'}
			<ContactsView />
		{:else}
			<MemoryInsightsView />
		{/if}
	</div>
</div>
