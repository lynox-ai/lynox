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
				<li class="group">
					<button
						onclick={() => onselect(thread.id)}
						class="w-full text-left rounded-[var(--radius-sm)] px-3 py-1.5 text-sm transition-all flex items-center justify-between gap-1
						{isActive
							? 'bg-accent/10 text-accent-text'
							: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
					>
						<span class="truncate flex-1 text-xs">
							{thread.title || t('threads.no_title')}
						</span>
						<span class="text-[10px] text-text-subtle shrink-0">
							{timeAgo(thread.updated_at)}
						</span>
					</button>
					<!-- Archive button on hover -->
					<button
						onclick={(e: MouseEvent) => { e.stopPropagation(); void archiveThread(thread.id); }}
						class="hidden group-hover:block absolute right-5 text-text-subtle hover:text-text text-xs"
						aria-label={t('threads.archive')}
					>
						&times;
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
