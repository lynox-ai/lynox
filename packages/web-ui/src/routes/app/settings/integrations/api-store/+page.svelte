<!--
	API Store sub-route reservation (PRD-SETTINGS-REFACTOR Phase 4 +
	Cleanup-Owe for PRD-UNIFIED-API-PROFILE-V2). Mounts the existing
	read-only `ApiStoreView` under the integrations namespace so the
	profile-editing UI from V2 has a stable home when it lands.
-->
<script lang="ts">
	import ApiStoreView from '$lib/components/ApiStoreView.svelte';
</script>

<ApiStoreView />
