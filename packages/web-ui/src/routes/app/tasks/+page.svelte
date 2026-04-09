<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	onMount(() => goto('/app/activity?tab=tasks', { replaceState: true }));
</script>
