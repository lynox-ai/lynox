<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { addToast } from '$lib/stores/toast.svelte.js';
	import { t } from '$lib/i18n.svelte.js';

	// `/app/automation` is the legacy URL. PRD-SETTINGS-REFACTOR moved the
	// Activity Hub to `/app/hub`. Existing bookmarks land here and get
	// forwarded with their query-string AND hash preserved. The toast fires
	// once per browser tab (sessionStorage) — re-navigating to /app/automation
	// later in the same tab is silent.
	onMount(() => {
		const target = '/app/hub' + ($page.url.search ?? '') + ($page.url.hash ?? '');
		if (typeof sessionStorage !== 'undefined' && !sessionStorage.getItem('migration_automation_to_hub')) {
			sessionStorage.setItem('migration_automation_to_hub', '1');
			addToast(t('hub.migration_toast'), 'info', 6000);
		}
		void goto(target, { replaceState: true });
	});

	// SSR-time target for the meta-refresh below — `$page.url.search` is
	// populated server-side, so the no-JS fallback at least preserves the
	// query string. The fragment (`#…`) is fundamentally client-only — browsers
	// strip it before issuing the request — and cannot be recovered without JS.
	const metaTarget = '/app/hub' + ($page.url.search ?? '');
</script>

<!-- No-JS fallback: browsers without JavaScript get a meta-refresh redirect.
     Preserves the query string (rendered server-side); fragment hash is lost
     in no-JS mode because browsers never send it on the request. -->
<svelte:head>
	<meta http-equiv="refresh" content={`0;url=${metaTarget}`} />
</svelte:head>
