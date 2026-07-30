<script lang="ts">
	import '../app.css';
	import { untrack } from 'svelte';
	import { initLocale, setLocale } from '$lib/i18n.svelte.js';
	import { initTheme } from '$lib/stores/theme.svelte.js';
	import { configure } from '$lib/config.svelte.js';
	import { triggerStaleReload } from '$lib/utils/stale-reload.js';
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

	// Warm-tab stale-bundle recovery. After a deploy an open tab's cached,
	// content-hashed dynamic-import chunks 404 against the new server; Vite
	// fires `vite:preloadError` for each such failure (Mermaid's lazy chunk,
	// lazy route chunks, …). Hard-reload onto the fresh build. The cold-start
	// case is handled by the inline SHA guard in app.html. `$effect` runs
	// client-only, so `window` is never touched during SSR.
	$effect(() => {
		const onPreloadError = (): void => triggerStaleReload();
		window.addEventListener('vite:preloadError', onPreloadError);
		return () => window.removeEventListener('vite:preloadError', onPreloadError);
	});
</script>

<svelte:head>
	{#if demoLocale}<meta name="lynox-demo-locale" content={demoLocale} />{/if}
</svelte:head>

{@render children()}
<ToastContainer />
