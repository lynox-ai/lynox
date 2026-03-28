<script lang="ts">
	import AppLayout from '$lib/components/AppLayout.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<AppLayout>
	{@render children()}
</AppLayout>
