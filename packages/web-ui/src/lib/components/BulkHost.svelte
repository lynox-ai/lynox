<!--
	BulkHost — a value the planner or the owner set (a host, an address, an allowed domain), boxed as
	code where it meets the page's own words, like a planner-set field name (U-333). It wraps after a
	dot, a slash or a space, never at a hyphen inside a name; each piece stays whole while it fits on a
	line, and only a piece longer than a line breaks inside (U-423). A space stays text outside the
	pieces, so it shows and a line may end there.
-->
<script lang="ts">
	import { BULK_HOST_BOX, bulkBoxParts } from './bulk-runs.js';

	let { value, testid = 'bulk-host' }: { value: string; testid?: string } = $props();
	const parts = $derived(bulkBoxParts(value));
</script>

<code class={BULK_HOST_BOX} data-testid={testid}>{#each parts as part, i (i)}{@const word = part.trimEnd()}{#if word !== ''}<span class="inline-block max-w-full break-all">{word}</span>{/if}{part.slice(word.length)}{#if i < parts.length - 1 && word.length === part.length}<wbr />{/if}{/each}</code>
