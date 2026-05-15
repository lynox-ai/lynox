<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	// The Data surface moved from Settings → Intelligence (its conceptual
	// home — neighbours: Knowledge, Graph, Contacts, Insights). Keep this
	// page as a client-side redirect so existing bookmarks and the in-app
	// "Back to Settings" link from a stale tab don't break.
	onMount(() => {
		void goto('/app/intelligence?tab=data', { replaceState: true });
	});
</script>
