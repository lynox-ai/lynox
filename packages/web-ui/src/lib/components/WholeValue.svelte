<script lang="ts">
	import { valueSegments, type ValueKind } from '../utils/value-breaks.js';

	// A host or URL kept whole (U-391): the box moves to the next line when the value fits on one,
	// and a longer value breaks between its pieces, after a dot (a URL also after a slash), not at a
	// hyphen. Each piece is its own box: whole while it fits on a line; only a piece longer than a
	// line (a long id in a path) breaks inside, anywhere, rather than running out of the card.
	let { value, kind = 'host', class: cls = '', testid = undefined }: { value: string; kind?: ValueKind; class?: string; testid?: string | undefined } = $props();
</script>

<span class="inline-block max-w-full {cls}" data-testid={testid}>{#each valueSegments(value, kind) as seg, i (i)}{#if i > 0}<wbr />{/if}<span class="inline-block max-w-full break-all">{seg}</span>{/each}</span>
