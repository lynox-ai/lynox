<script lang="ts">
	// IA reorg (D2): API Profiles are low-frequency config, so their home is
	// Settings (not the Automation Hub). The hub's `?section=apis` now 301s here
	// (see routes/app/hub/+page.ts). ApiStoreView owns its own padding + fetch.
	import ApiStoreView from '$lib/components/ApiStoreView.svelte';
</script>

<ApiStoreView />
