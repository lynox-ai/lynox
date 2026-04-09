<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	onMount(() => goto('/app/knowledge?tab=insights', { replaceState: true }));
</script>
