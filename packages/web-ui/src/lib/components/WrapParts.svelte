<script lang="ts">
	import { bulkWrapParts } from './bulk-runs.js';

	// A heading or line that wraps at spaces and after a dot, never at a hyphen inside a name
	// (U-374, U-383): `summer-shoes-test.` / `myshopify.com`. Each word is its own box, whole while
	// it fits on a line; only a word longer than a line (a long store handle at 390 px) breaks
	// inside, rather than running out sideways. The space after a word stays text, so it shows and
	// a line may end there.
	let { text }: { text: string } = $props();
</script>

{#each bulkWrapParts(text) as part, i (i)}{@const word = part.text.trimEnd()}{#if word !== ''}<span class="inline-block max-w-full break-all">{word}</span>{/if}{part.text.slice(word.length)}{#if part.wrap && word.length === part.text.length}<wbr />{/if}{/each}
