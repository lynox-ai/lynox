<script lang="ts">
	import { onMount } from 'svelte';
	import ChatView from '$lib/components/ChatView.svelte';
	import { resumeThread } from '$lib/stores/chat.svelte.js';

	// Push-notification deep link: `?thread=<uuid>` is set by the service worker's
	// notificationclick handler for a completed (or question-awaiting) background
	// task — see worker-loop.ts + static/sw.js. Resume that thread once, then strip
	// the query so a refresh doesn't re-resume it. resumeThread is authoritative
	// (sets the active thread + generation-guards concurrent switches), so it wins
	// over the persisted-thread reconcile ChatView runs on mount.
	onMount(() => {
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		const threadId = url.searchParams.get('thread');
		if (!threadId) return;
		void resumeThread(threadId);
		url.searchParams.delete('thread');
		window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
	});
</script>

<ChatView />
