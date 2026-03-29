<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../i18n.svelte.js';
	import { getThreads, loadThreads, archiveThread, getIsLoadingThreads } from '../stores/threads.svelte.js';
	import { getSessionId } from '../stores/chat.svelte.js';

	let { onselect }: { onselect: (threadId: string) => void } = $props();

	onMount(() => {
		void loadThreads();
	});

	function timeAgo(dateStr: string): string {
		const diff = Date.now() - new Date(dateStr + 'Z').getTime();
		const mins = Math.floor(diff / 60_000);
		if (mins < 1) return 'now';
		if (mins < 60) return `${mins}m`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `${hours}h`;
		const days = Math.floor(hours / 24);
		return `${days}d`;
	}
</script>

{#if getThreads().length > 0}
	<div class="px-3 mb-2">
		<p class="text-[10px] uppercase tracking-wider text-text-subtle px-3 mb-1">{t('threads.recent')}</p>
		<ul class="space-y-0.5 max-h-48 overflow-y-auto scrollbar-thin">
			{#each getThreads().slice(0, 10) as thread (thread.id)}
				{@const isActive = getSessionId() === thread.id}
				<li class="group relative flex items-center rounded-[var(--radius-sm)] transition-all
						{isActive
							? 'bg-accent/10 text-accent-text'
							: 'text-text-muted hover:text-text hover:bg-bg-muted'}">
					<button
						onclick={() => onselect(thread.id)}
						class="flex-1 text-left px-3 py-1.5 text-xs truncate"
					>
						{thread.title || t('threads.no_title')}
					</button>
					<span class="text-[10px] text-text-subtle shrink-0 pr-2 group-hover:hidden">
						{timeAgo(thread.updated_at)}
					</span>
					<button
						onclick={(e: MouseEvent) => { e.stopPropagation(); void archiveThread(thread.id); }}
						class="hidden group-hover:flex shrink-0 items-center justify-center h-5 w-5 mr-1 rounded text-text-subtle hover:text-danger hover:bg-danger/10 text-xs transition-colors"
						aria-label={t('threads.archive')}
					>&times;</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
