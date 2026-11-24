<script lang="ts">
	import MarkedLine, { VALUE_BOX } from './MarkedLine.svelte';
	import { segments } from '../utils/plan-takeover.js';
	import { valueSegments, type ValueKind } from '../utils/value-breaks.js';

	// One value someone else wrote, set apart in the same box as `MarkedLine`, and kept whole by the
	// value rule (U-428): the box moves to the next line whole while it fits, a longer value breaks
	// between its pieces (after a dot, `@` or `/`), never at a hyphen; only a piece longer than a line
	// breaks inside. `text` comes from `shownValue` / `shownWhole`, which did the neutralising: this
	// only draws. Anything that is not exactly one marked value is drawn by `MarkedLine` as it is.
	let { text, kind = 'account', testid = undefined }: { text: string; kind?: ValueKind; testid?: string | undefined } = $props();
	const parts = $derived(segments(text));
	const one = $derived(parts.length === 1 && parts[0]!.foreign ? parts[0]!.text : null);
</script>

{#if one !== null}<span class="inline-block max-w-full" data-testid={testid}><bdi data-foreign-value class="{VALUE_BOX} font-mono">{#each valueSegments(one, kind) as seg, i (i)}{#if i > 0}<wbr />{/if}<span class="inline-block max-w-full break-all">{seg}</span>{/each}</bdi></span>{:else}<span class="inline-block max-w-full" data-testid={testid}><MarkedLine {text} /></span>{/if}
