<script lang="ts">
	import { onMount } from 'svelte';
	import InboxView from '$lib/components/InboxView.svelte';
	import { openItem } from '$lib/stores/inbox.svelte.js';

	// Push-notification deep link: `?item=<inb_…>` is set by the service
	// worker's notificationclick handler. Open the mail once, then strip
	// the query so a refresh doesn't re-open the same item ad nauseam.
	onMount(() => {
		if (typeof window === 'undefined') return;
		const url = new URL(window.location.href);
		const itemId = url.searchParams.get('item');
		if (!itemId) return;
		void openItem(itemId);
		url.searchParams.delete('item');
		window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
	});
</script>

<InboxView />
