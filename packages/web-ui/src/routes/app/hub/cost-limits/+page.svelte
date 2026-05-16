<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import CostLimits from '$lib/components/CostLimits.svelte';
	import { addToast } from '$lib/stores/toast.svelte.js';
	import { t } from '$lib/i18n.svelte.js';

	// PRD-IA-V2 P2-PR-F: one-time transition toast on the first visit to the
	// (now deprecated) Cost-Limits route after the P2 deploy. The page itself
	// still renders during the interim (P2-PR-C deprecation banner inside the
	// component); final deletion lands P3-PR-X once /workspace/limits ships.
	//
	// localStorage gate, not sessionStorage — we want the toast to fire exactly
	// once per browser, not once per tab. CTA links to /app/settings/llm where
	// the context-window radio already lives in v1.6 via P2-PR-C.
	const TOAST_FLAG = 'lynox.p2.cost-limits-toast.seen';

	onMount(() => {
		if (typeof localStorage === 'undefined') return;
		if (localStorage.getItem(TOAST_FLAG)) return;
		localStorage.setItem(TOAST_FLAG, '1');
		addToast(t('cost_limits.toast.message'), 'info', 6000, {
			label: t('cost_limits.toast.cta'),
			handler: () => {
				void goto('/app/settings/llm');
			},
		});
	});
</script>

<CostLimits />
