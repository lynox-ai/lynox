<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	onMount(() => {
		goto('/app/settings/config?tab=provider', { replaceState: true });
	});
</script>
