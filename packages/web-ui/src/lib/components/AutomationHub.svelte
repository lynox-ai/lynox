<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { t } from '../i18n.svelte.js';
	import ActivityHub from './ActivityHub.svelte';
	import TasksView from './TasksView.svelte';
	import WorkflowsView from './WorkflowsView.svelte';

	type Tab = 'workflows' | 'tasks' | 'activity';

	// `?section=` (not `?tab=`) is intentional — the embedded ActivityHub uses
	// `?tab=` for its own dashboard/usage/history sub-tabs and a single
	// param-name would collide.
	const tab = $derived<Tab>(((): Tab => {
		const p = $page.url.searchParams.get('section');
		if (p === 'tasks' || p === 'activity') return p;
		return 'workflows';
	})());

	function setTab(next: Tab): void {
		const url = new URL($page.url);
		if (next === 'workflows') url.searchParams.delete('section');
		else url.searchParams.set('section', next);
		// Drop ActivityHub's inner ?tab= when leaving the activity section so
		// the URL doesn't carry stale state.
		if (next !== 'activity') url.searchParams.delete('tab');
		void goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
	}

	const tabs: ReadonlyArray<{ id: Tab; labelKey: string }> = [
		{ id: 'workflows', labelKey: 'hub.automation.workflows' },
		{ id: 'tasks', labelKey: 'hub.automation.tasks' },
		{ id: 'activity', labelKey: 'hub.automation.activity' },
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
		{#if tab === 'workflows'}
			<WorkflowsView />
		{:else if tab === 'tasks'}
			<TasksView />
		{:else}
			<ActivityHub />
		{/if}
	</div>
</div>
