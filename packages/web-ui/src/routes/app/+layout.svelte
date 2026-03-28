<script lang="ts">
	import AppShell from '$lib/components/AppShell.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<AppShell>
	{@render children()}
</AppShell>
