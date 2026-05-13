<script lang="ts">
	import { page } from '$app/stores';
	import { t } from '../i18n.svelte.js';
	import ActivityHub from './ActivityHub.svelte';
	import TasksView from './TasksView.svelte';
	import WorkflowsView from './WorkflowsView.svelte';

	type Tab = 'workflows' | 'tasks' | 'activity';

	let tab = $state<Tab>('workflows');

	$effect(() => {
		const p = $page.url.searchParams.get('section');
		if (p === 'tasks' || p === 'activity') tab = p;
		else tab = 'workflows';
	});

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
				onclick={() => (tab = t_item.id)}
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
