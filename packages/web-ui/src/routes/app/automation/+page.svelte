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
</script>

<!-- No-JS fallback: browsers without JavaScript get a meta-refresh redirect
     (the toast won't fire, but the URL still updates). -->
<svelte:head>
	<meta http-equiv="refresh" content="0;url=/app/hub" />
</svelte:head>
