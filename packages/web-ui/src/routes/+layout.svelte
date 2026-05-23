<script lang="ts">
	import '../app.css';
	import { untrack } from 'svelte';
	import { initLocale, setLocale } from '$lib/i18n.svelte.js';
	import { initTheme } from '$lib/stores/theme.svelte.js';
	import { configure } from '$lib/config.svelte.js';
	import ToastContainer from '$lib/components/ToastContainer.svelte';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types.js';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();

	// data.demoMode / data.demoLocale are SSR-only and never change after
	// hydration. untrack() silences the "reads initial value only" warning
	// without invoking $effect (which would defer to after mount).
	const { demoMode, demoLocale } = untrack(() => ({
		demoMode: data.demoMode,
		demoLocale: data.demoLocale,
	}));

	if (demoMode) {
		configure({ demoMode: true });
		if (demoLocale) setLocale(demoLocale);
	} else {
		initLocale();
	}
	initTheme();
</script>

<svelte:head>
	{#if demoLocale}<meta name="lynox-demo-locale" content={demoLocale} />{/if}
</svelte:head>

{@render children()}
<ToastContainer />
