<script lang="ts">
	import { goto } from '$app/navigation';
	import { newChat } from '../stores/chat.svelte.js';
	import { t } from '../i18n.svelte.js';
	import { onMount, onDestroy } from 'svelte';
	import Icon from '../primitives/Icon.svelte';

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
		// PRD-IA-V2 P2-PR-E: Activity has its own root since P2-PR-A. Position
		// matches Desktop-Sidebar (after Chat/Inbox, before Hub) so palette
		// search aligns with the nav-rail. Inbox is feature-flag gated and
		// intentionally has no palette entry today — added when the flag GAs.
		{ id: 'nav-activity', label: t('nav.activity'), group: t('cmd.nav'), action: () => goto('/app/activity'), keywords: 'activity aktivität cost kosten history runs verbrauch usage' },
		{ id: 'nav-automation', label: t('nav.automation'), group: t('cmd.nav'), action: () => goto('/app/hub'), keywords: 'workflows pipelines automation dag abläufe tasks aufgaben hub' },
		{ id: 'nav-intelligence', label: t('nav.intelligence'), group: t('cmd.nav'), action: () => goto('/app/intelligence'), keywords: 'intelligence dashboards reports knowledge memory wissen graph insights kpi contacts kontakte crm' },
		{ id: 'nav-artifacts', label: t('nav.artifacts'), group: t('cmd.nav'), action: () => goto('/app/artifacts'), keywords: 'artifacts dashboards diagrams files galerie' },
		{ id: 'nav-settings', label: t('nav.settings'), group: t('cmd.nav'), action: () => goto('/app/settings'), keywords: 'settings einstellungen config' },
		// PRD-IA-V2 P1-PR-C — `/app/settings/keys` is now a 301 stub; SecretsView
		// (generic API-Key CRUD for Tavily/Brevo/custom) lives at `/llm/keys`,
		// the SSoT per PRD. Palette skips the redirect bounce and lands directly.
		{ id: 'nav-keys', label: t('settings.keys'), group: t('cmd.nav'), action: () => goto('/app/settings/llm/keys'), keywords: 'keys api schluessel' },
		{ id: 'nav-integrations', label: t('settings.integrations'), group: t('cmd.nav'), action: () => goto('/app/settings/integrations'), keywords: 'integrations google tavily mail email imap smtp' },
		// PRD-IA-V2 P1-PR-A2 — /app/settings/config was deleted; target the
		// LLM-page (Provider + Model + Advanced + Memory). Phase-3 splits this
		// further into /llm/advanced, /llm/memory, /workspace/limits, etc.
		{ id: 'nav-config', label: t('settings.config'), group: t('cmd.nav'), action: () => goto('/app/settings/llm'), keywords: 'config model effort thinking budget backup provider llm' },
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
			<Icon name="search" size="sm" class="text-text-subtle" />
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
