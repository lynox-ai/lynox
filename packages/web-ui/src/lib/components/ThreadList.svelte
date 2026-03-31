<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../i18n.svelte.js';
	import { getThreads, loadThreads, archiveThread, toggleFavorite, getIsLoadingThreads } from '../stores/threads.svelte.js';
	import { getSessionId } from '../stores/chat.svelte.js';

	let { onselect }: { onselect: (threadId: string) => void } = $props();

	let swipedThreadId = $state<string | null>(null);
	let dragStartX = 0;
	let dragNode: HTMLElement | null = null;

	function closeSwipe() {
		if (!swipedThreadId) return;
		const el = document.querySelector(`[data-swipe-tl="${swipedThreadId}"]`) as HTMLElement | null;
		if (el) el.style.transform = '';
		swipedThreadId = null;
	}

	function onSwipeStart(e: TouchEvent, threadId: string) {
		dragStartX = e.touches[0].clientX;
		dragNode = e.currentTarget as HTMLElement;
		dragNode.style.transition = 'none';
		if (swipedThreadId && swipedThreadId !== threadId) closeSwipe();
	}

	function onSwipeMove(e: TouchEvent) {
		if (!dragNode) return;
		const dx = e.touches[0].clientX - dragStartX;
		if (dx < 0) dragNode.style.transform = `translateX(${Math.max(dx, -72)}px)`;
		else if (swipedThreadId) dragNode.style.transform = `translateX(${Math.min(-72 + dx, 0)}px)`;
	}

	function onSwipeEnd(threadId: string) {
		if (!dragNode) return;
		dragNode.style.transition = '';
		const match = /translateX\((-?\d+)/.exec(dragNode.style.transform);
		const offset = match ? parseInt(match[1]) : 0;
		if (offset < -36) {
			dragNode.style.transform = 'translateX(-72px)';
			swipedThreadId = threadId;
		} else {
			dragNode.style.transform = '';
			if (swipedThreadId === threadId) swipedThreadId = null;
		}
		dragNode = null;
	}

	onMount(() => {
		void loadThreads();
	});

	function timeAgo(dateStr: string): string {
		const parsed = new Date(dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z');
		const diff = Date.now() - parsed.getTime();
		if (Number.isNaN(diff)) return '';
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
		<p class="text-xs uppercase tracking-wider text-text-subtle px-3 mb-1">{t('threads.recent')}</p>
		<ul class="space-y-0.5 max-h-72 overflow-y-auto scrollbar-thin">
			{#each getThreads() as thread (thread.id)}
				{@const isActive = getSessionId() === thread.id}
				<li class="relative overflow-hidden rounded-[var(--radius-sm)]">
					<!-- Swipe archive action (mobile) -->
					<button
						onclick={(e: MouseEvent) => { e.stopPropagation(); void archiveThread(thread.id); closeSwipe(); }}
						class="absolute inset-y-0 right-0 z-0 flex items-center px-4 bg-danger/20 text-danger text-sm font-medium"
						aria-label={t('threads.archive')}
					>{t('threads.archive')}</button>
					<div
						role="group"
						data-swipe-tl={thread.id}
						ontouchstart={(e) => onSwipeStart(e, thread.id)}
						ontouchmove={onSwipeMove}
						ontouchend={() => onSwipeEnd(thread.id)}
						class="group relative z-10 flex items-center bg-bg-subtle transition-transform duration-150
						{isActive
							? 'bg-accent/10 text-accent-text'
							: 'text-text-muted hover:text-text hover:bg-bg-muted'}"
					>
						<button
							onclick={() => { if (swipedThreadId) { closeSwipe(); return; } onselect(thread.id); }}
							class="flex-1 text-left px-3 py-2 text-sm truncate"
						>
							{thread.title || t('threads.no_title')}
						</button>
						{#if thread.is_favorite}
							<span class="text-accent text-xs shrink-0 pr-1 group-hover:hidden">&#9733;</span>
						{:else}
							<span class="text-xs text-text-subtle shrink-0 pr-2 group-hover:hidden">
								{timeAgo(thread.updated_at)}
							</span>
						{/if}
						<button
							onclick={(e: MouseEvent) => { e.stopPropagation(); void toggleFavorite(thread.id); }}
							class="hidden group-hover:flex shrink-0 items-center justify-center h-5 w-5 mr-1 rounded text-text-subtle hover:text-accent hover:bg-accent/10 text-xs transition-colors"
							aria-label={thread.is_favorite ? t('threads.unfavorite') : t('threads.favorite')}
						>{thread.is_favorite ? '\u2605' : '\u2606'}</button>
						<button
							onclick={(e: MouseEvent) => { e.stopPropagation(); void archiveThread(thread.id); }}
							class="hidden group-hover:flex shrink-0 items-center justify-center h-5 w-5 mr-1 rounded text-text-subtle hover:text-danger hover:bg-danger/10 text-xs transition-colors"
							aria-label={t('threads.archive')}
						>&times;</button>
					</div>
				</li>
			{/each}
		</ul>
	</div>
{/if}
