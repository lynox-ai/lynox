<script lang="ts">
	import MobileAccess from '$lib/components/MobileAccess.svelte';
	import type { PageData } from './$types.js';

	let { data }: { data: PageData } = $props();
</script>

<MobileAccess hasSecret={data.hasSecret} linkCode={data.linkCode} />
