<script lang="ts">
	import AppShell from '$lib/components/AppShell.svelte';
	import PasskeyPrompt from '$lib/components/PasskeyPrompt.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<svelte:head>
	<title>lynox</title>
</svelte:head>

<AppShell>
	{@render children()}
</AppShell>
<PasskeyPrompt />
