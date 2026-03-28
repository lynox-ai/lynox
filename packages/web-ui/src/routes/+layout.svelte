<script lang="ts">
	import '../app.css';
	import { initLocale } from '$lib/i18n.svelte.js';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	initLocale();
</script>

{@render children()}
