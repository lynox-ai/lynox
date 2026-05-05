<script lang="ts">
	import '../app.css';
	import { initLocale } from '$lib/i18n.svelte.js';
	import { configure } from '$lib/config.svelte.js';
	import ToastContainer from '$lib/components/ToastContainer.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	initLocale();

	// Pipeline-status-v2 canary flag. Set PUBLIC_LYNOX_UI_PIPELINE_STATUS_V2=1
	// in the deploy env (staging or per-user prod CP) to enable. Default off.
	// Library consumers (pro/pwa) can call configure() directly from their own
	// boot code instead of relying on the env.
	const flag = import.meta.env['PUBLIC_LYNOX_UI_PIPELINE_STATUS_V2'];
	if (flag === '1' || flag === 'true') configure({ pipelineStatusV2: true });
</script>

{@render children()}
<ToastContainer />
