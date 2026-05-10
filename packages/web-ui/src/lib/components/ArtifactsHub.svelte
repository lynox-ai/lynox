<script lang="ts">
	import { page } from '$app/stores';
	import { t } from '../i18n.svelte.js';
	import ArtifactsView from './ArtifactsView.svelte';
	import FileBrowserView from './FileBrowserView.svelte';

	let tab = $state<'gallery' | 'files'>('gallery');

	$effect(() => {
		if ($page.url.searchParams.get('tab') === 'files') tab = 'files';
		else tab = 'gallery';
	});

	const tabs = [
		{ id: 'gallery' as const, labelKey: 'hub.artifacts.gallery' },
		{ id: 'files' as const, labelKey: 'hub.artifacts.files' },
	];
</script>

<div class="flex flex-col h-full">
	<div class="flex items-center gap-1 px-4 sm:px-5 py-3 border-b border-border shrink-0 overflow-x-auto scrollbar-none">
		{#each tabs as t_item}
			<button
				type="button"
				class="shrink-0 whitespace-nowrap px-3 py-1.5 rounded-[var(--radius-sm)] text-xs font-medium transition-colors {tab === t_item.id ? 'bg-accent/10 text-accent-text' : 'text-text-muted hover:text-text hover:bg-bg-muted'}"
				onclick={() => tab = t_item.id}
			>{t(t_item.labelKey)}</button>
		{/each}
	</div>
	<div class="flex-1 overflow-y-auto">
		{#if tab === 'gallery'}
			<ArtifactsView />
		{:else}
			<FileBrowserView />
		{/if}
	</div>
</div>
