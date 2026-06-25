<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { t } from '../i18n.svelte.js';
	import TasksView from './TasksView.svelte';
	import TriggersView from './TriggersView.svelte';
	import WorkflowLibraryView from './WorkflowLibraryView.svelte';

	// PRD-IA-V2 P2-PR-D — Activity tab stripped. AutomationHub is now Builder-only.
	// `/app/hub?section=activity*` is redirected SSR-side by
	// `routes/app/hub/+page.ts` to `/app/activity?tab=*`.
	// IA reorg (D2): `apis` (API Profiles) + `keys` (3rd-party credentials) are
	// low-frequency config — moved OUT of Automation into Settings
	// (`/app/settings/apis`, `/app/settings/llm/keys`). Their legacy
	// `?section=apis|keys` URLs 301 to Settings via `routes/app/hub/+page.ts`.
	// IA reorg: the `workflows` tab is now the workflow *definitions* surface
	// (Library). The separate `library` tab is retired — its `?section=library`
	// URL rewrites to `workflows` (back-compat $effect below). The run-list moved
	// to Activity & Cost (`/app/activity?tab=workflows`).
	type Tab = 'workflows' | 'triggers' | 'tasks';

	// `?section=` (not `?tab=`) is intentional — historic collision-avoidance
	// with the embedded ActivityHub which used `?tab=`. Now that Activity is
	// gone the collision can't happen, but the URL contract is stable for
	// bookmarks. `reminders` was a separate tab that re-rendered TasksView
	// filtered to reminders. Reminders are agent-triggers (the `triggers`
	// table), so the IA Triggers-home is now their home: legacy
	// `?section=reminders` rewrites to `?section=triggers` via the $effect
	// below (1-release grace; cleanup later).
	const tab = $derived<Tab>(((): Tab => {
		const p = $page.url.searchParams.get('section');
		if (p === 'triggers' || p === 'tasks') return p;
		if (p === 'reminders') return 'triggers'; // back-compat: reminders are agent-triggers
		if (p === 'library') return 'workflows';  // back-compat: Library folded into the Workflows tab
		return 'workflows';
	})());

	// Rewrite legacy `?section=` values to their current canonical tab on first
	// load so the URL bar matches the rendered tab (without this the user looks
	// at one tab but the URL says another — sharing/copying it lands the
	// recipient on the same redirect dance). `reminders` → `triggers` (reminders
	// are agent-triggers); `library` → strip `?section=` (Library is now the
	// default Workflows tab, whose canonical URL carries no `?section=`).
	$effect(() => {
		const section = $page.url.searchParams.get('section');
		if (section === 'reminders') {
			const url = new URL($page.url);
			url.searchParams.set('section', 'triggers');
			void goto(url.pathname + url.search, { replaceState: true, keepFocus: true, noScroll: true });
		} else if (section === 'library') {
			const url = new URL($page.url);
			url.searchParams.delete('section');
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
		{ id: 'triggers', labelKey: 'hub.automation.triggers' },
		{ id: 'tasks', labelKey: 'hub.automation.tasks' },
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
			<WorkflowLibraryView />
		{:else if tab === 'triggers'}
			<TriggersView />
		{:else}
			<TasksView />
		{/if}
	</div>
</div>
