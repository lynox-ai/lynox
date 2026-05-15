<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	// API Profiles moved from Settings → Automation (its conceptual home —
	// the building blocks of how the agent talks to external services,
	// alongside Workflows + Tasks). Client-side redirect so existing
	// bookmarks and stale in-app links don't 404.
	onMount(() => {
		void goto('/app/hub?section=apis', { replaceState: true });
	});
</script>
