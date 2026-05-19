<script lang="ts">
	import '../app.css';
	import { initLocale } from '$lib/i18n.svelte.js';
	import { initTheme } from '$lib/stores/theme.svelte.js';
	import ToastContainer from '$lib/components/ToastContainer.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	initLocale();
	initTheme();
</script>

{@render children()}
<ToastContainer />
