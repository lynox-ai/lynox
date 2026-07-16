<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { getApiBase } from '../config.svelte.js';
	import { t } from '../i18n.svelte.js';
	import ContactsView from './ContactsView.svelte';
	import DataStoreView from './DataStoreView.svelte';
	import KnowledgeGraphView from './KnowledgeGraphView.svelte';
	import MemoryInsightsView from './MemoryInsightsView.svelte';
	import MemoryView from './MemoryView.svelte';
	import SubjectsView from './SubjectsView.svelte';
	import KnowledgeQueueView from './KnowledgeQueueView.svelte';
	import { scrollFade } from '../utils/scroll-fade.js';

	// PRD-IA-V2 P3-PR-H: IntelligenceHub shrinks 5 → 4 top-tabs.
	// `insights` is folded as a sub-tab under `graph` (both Beta, both
	// AgentMemoryDb-aggregate). Legacy `?tab=insights` is 301-redirected to
	// `?tab=graph&sub=insights` by the route's `+page.ts` for bookmark survival.
	// R2b: a `subjects` tab appears ONLY when the engine reports
	// capabilities.has_subject_graph (subject_graph_enabled — fleet OFF today).
	type Tab = 'wissen' | 'graph' | 'contacts' | 'data' | 'subjects' | 'queue';
	type GraphSub = 'overview' | 'insights';

	let hasSubjectGraph = $state(false);
	// DK.2: the review-queue tab appears ONLY when durable_memory_enabled wired
	// the KnowledgeStore (capabilities.has_durable_memory — fleet OFF today).
	let hasDurableMemory = $state(false);
	let queueCount = $state(0);

	$effect(() => {
		void (async () => {
			try {
				const res = await fetch(`${getApiBase()}/config`);
				if (!res.ok) return;
				const body = (await res.json()) as { capabilities?: { has_subject_graph?: boolean; has_durable_memory?: boolean } };
				hasSubjectGraph = body.capabilities?.has_subject_graph === true;
				hasDurableMemory = body.capabilities?.has_durable_memory === true;
				if (hasDurableMemory) void refreshQueueCount();
			} catch { /* leave the tabs hidden on probe failure */ }
		})();
	});

	async function refreshQueueCount(): Promise<void> {
		try {
			const res = await fetch(`${getApiBase()}/knowledge/queue/count`);
			if (!res.ok) return;
			const body = (await res.json()) as { pendingCount?: number };
			queueCount = body.pendingCount ?? 0;
		} catch { /* badge stays at the last known count */ }
	}

	const tab = $derived<Tab>(((): Tab => {
		const p = $page.url.searchParams.get('tab');
		if (p === 'graph' || p === 'contacts' || p === 'data') return p;
		if (p === 'subjects' && hasSubjectGraph) return 'subjects';
		if (p === 'queue' && hasDurableMemory) return 'queue';
		return 'wissen';
	})());

	const graphSub = $derived<GraphSub>(((): GraphSub => {
		if (tab !== 'graph') return 'overview';
		const s = $page.url.searchParams.get('sub');
		return s === 'insights' ? 'insights' : 'overview';
	})());

	function setTab(next: Tab): void {
		const url = new URL($page.url);
		if (next === 'wissen') url.searchParams.delete('tab');
		else url.searchParams.set('tab', next);
		// Switching top-tab always drops the sub-tab; `sub` is scoped to `graph`.
		url.searchParams.delete('sub');
		void goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
	}

	function setGraphSub(next: GraphSub): void {
		const url = new URL($page.url);
		url.searchParams.set('tab', 'graph');
		if (next === 'overview') url.searchParams.delete('sub');
		else url.searchParams.set('sub', next);
		void goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
	}

	const tabs = $derived<ReadonlyArray<{ id: Tab; labelKey: string }>>([
		{ id: 'wissen', labelKey: 'hub.intelligence.wissen' },
		{ id: 'graph', labelKey: 'hub.intelligence.graph' },
		{ id: 'contacts', labelKey: 'hub.intelligence.contacts' },
		{ id: 'data', labelKey: 'hub.intelligence.data' },
		...(hasSubjectGraph ? [{ id: 'subjects' as const, labelKey: 'hub.intelligence.subjects' }] : []),
		...(hasDurableMemory ? [{ id: 'queue' as const, labelKey: 'hub.intelligence.queue' }] : []),
	]);

	const graphSubTabs: ReadonlyArray<{ id: GraphSub; labelKey: string }> = [
		{ id: 'overview', labelKey: 'hub.intelligence.graph_overview' },
		{ id: 'insights', labelKey: 'hub.intelligence.insights' },
	];
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center gap-1 px-4 sm:px-5 py-3 border-b border-border shrink-0 overflow-x-auto scrollbar-none" use:scrollFade>
		{#each tabs as t_item (t_item.id)}
			<button
				type="button"
				class="inline-flex items-center justify-center min-h-[44px] sm:min-h-0 shrink-0 whitespace-nowrap px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors {tab === t_item.id ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
				onclick={() => setTab(t_item.id)}
			>{t(t_item.labelKey)}{#if t_item.id === 'queue' && queueCount > 0}<span class="ml-1.5 rounded-full bg-accent/15 text-accent-text px-1.5 text-[10px] font-mono">{queueCount}</span>{/if}</button>
		{/each}
	</div>
	{#if tab === 'graph'}
		<div class="flex items-center gap-1 px-4 sm:px-5 py-2 border-b border-border shrink-0 overflow-x-auto scrollbar-none" use:scrollFade>
			{#each graphSubTabs as s_item (s_item.id)}
				<button
					type="button"
					class="inline-flex items-center justify-center min-h-[44px] sm:min-h-0 shrink-0 whitespace-nowrap px-2.5 py-1 rounded-[var(--radius-sm)] text-[11px] font-medium transition-colors {graphSub === s_item.id ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
					onclick={() => setGraphSub(s_item.id)}
				>{t(s_item.labelKey)}</button>
			{/each}
		</div>
	{/if}
	<div class="flex-1 overflow-y-auto">
		{#if tab === 'wissen'}
			<MemoryView />
		{:else if tab === 'graph'}
			{#if graphSub === 'insights'}
				<MemoryInsightsView />
			{:else}
				<KnowledgeGraphView />
			{/if}
		{:else if tab === 'contacts'}
			<ContactsView />
		{:else if tab === 'subjects'}
			<SubjectsView />
		{:else if tab === 'queue'}
			<KnowledgeQueueView onCountChange={(n) => { queueCount = n; }} />
		{:else}
			<DataStoreView />
		{/if}
	</div>
</div>
