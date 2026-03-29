<script lang="ts">
	import { goto } from '$app/navigation';
	import { sendMessage } from '$lib/stores/chat.svelte.js';
	import ActivityHub from '$lib/components/ActivityHub.svelte';

	function rerun(task: string) {
		sendMessage(task);
		goto('/app');
	}
</script>

<ActivityHub onrerun={rerun} />
