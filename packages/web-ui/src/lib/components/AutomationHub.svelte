<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { t } from '../i18n.svelte.js';
	import ApiStoreView from './ApiStoreView.svelte';
	import TasksView from './TasksView.svelte';
	import WorkflowsView from './WorkflowsView.svelte';

	// PRD-IA-V2 P2-PR-D — Activity tab stripped. AutomationHub is now Builder-only.
	// `/app/hub?section=activity*` is redirected SSR-side by
	// `routes/app/hub/+page.ts` to `/app/activity?tab=*`.
	// `hub.automation.activity` i18n key intentionally kept here; retire = P2-PR-E.
	type Tab = 'workflows' | 'tasks' | 'apis';

	// `?section=` (not `?tab=`) is intentional — historic collision-avoidance
	// with the embedded ActivityHub which used `?tab=`. Now that Activity is
	// gone the collision can't happen, but the URL contract is stable for
	// bookmarks. `reminders` was a separate tab that just re-rendered
	// TasksView with `filterTaskType="reminder"` — same widget, different
	// filter, confusing. Folded into the unified Aufgaben tab; legacy URLs
	// still rewrite via the $effect below (1-release grace; cleanup later).
	const tab = $derived<Tab>(((): Tab => {
		const p = $page.url.searchParams.get('section');
		if (p === 'tasks' || p === 'apis') return p;
		if (p === 'reminders') return 'tasks'; // backwards-compat
		return 'workflows';
	})());

	// Rewrite legacy `?section=reminders` to `?section=tasks` on first load
	// so the URL bar matches the rendered tab. Without this the user is
	// looking at Tasks but the URL says reminders — sharing/copying it
	// would land the recipient on the same redirect dance.
	$effect(() => {
		if ($page.url.searchParams.get('section') === 'reminders') {
			const url = new URL($page.url);
			url.searchParams.set('section', 'tasks');
			void goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
		}
	});

	function setTab(next: Tab): void {
		const url = new URL($page.url);
		if (next === 'workflows') url.searchParams.delete('section');
		else url.searchParams.set('section', next);
		// Drop any stale inner `?tab=` (left over from when an Activity tab
		// lived here) so the URL doesn't carry state from the previous IA.
		url.searchParams.delete('tab');
		void goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
	}

	const tabs: ReadonlyArray<{ id: Tab; labelKey: string }> = [
		{ id: 'workflows', labelKey: 'hub.automation.workflows' },
		{ id: 'tasks', labelKey: 'hub.automation.tasks' },
		{ id: 'apis', labelKey: 'hub.automation.apis' },
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
			<ApiStoreView />
		{/if}
	</div>
</div>
