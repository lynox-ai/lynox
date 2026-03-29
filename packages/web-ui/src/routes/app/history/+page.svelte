<script lang="ts">
	import { goto } from '$app/navigation';
	import { sendMessage } from '$lib/stores/chat.svelte.js';
	import HistoryView from '$lib/components/HistoryView.svelte';

	function rerun(task: string) {
		sendMessage(task);
		goto('/app');
	}
</script>

<HistoryView onrerun={rerun} />
