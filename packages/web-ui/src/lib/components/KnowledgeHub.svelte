<script lang="ts">
	import { page } from '$app/stores';
	import { t } from '../i18n.svelte.js';
	import MemoryView from './MemoryView.svelte';
	import KnowledgeGraphView from './KnowledgeGraphView.svelte';
	import MemoryInsightsView from './MemoryInsightsView.svelte';

	let tab = $state<'knowledge' | 'graph' | 'insights'>('knowledge');

	$effect(() => {
		const p = $page.url.searchParams.get('tab');
		if (p === 'graph' || p === 'insights') tab = p;
	});

	const tabs = [
		{ id: 'knowledge' as const, labelKey: 'hub.knowledge.wissen' },
		{ id: 'graph' as const, labelKey: 'hub.knowledge.graph' },
		{ id: 'insights' as const, labelKey: 'hub.knowledge.insights' },
	];
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center gap-1 px-5 py-3 border-b border-border shrink-0">
		{#each tabs as t_item}
			<button
				type="button"
				class="px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors {tab === t_item.id ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
				onclick={() => tab = t_item.id}
			>{t(t_item.labelKey)}</button>
		{/each}
	</div>
	<div class="flex-1 overflow-y-auto">
		{#if tab === 'knowledge'}
			<MemoryView />
		{:else if tab === 'graph'}
			<KnowledgeGraphView />
		{:else}
			<MemoryInsightsView />
		{/if}
	</div>
</div>
