<script lang="ts">
	import { valueSegments } from '../utils/value-breaks.js';

	// A watched page's address, its host set off (U-391): the address moves to the next line whole
	// when it fits on one; a longer one breaks after a dot or slash, host and path flowing on in one
	// line, never at a hyphen inside the host. Each piece is its own box, whole while it fits on a
	// line; only a piece longer than a line breaks inside.
	let { host, rest = '', testid = undefined }: { host: string; rest?: string; testid?: string | undefined } = $props();
</script>

<span class="inline-block max-w-full" data-testid={testid}>{#each valueSegments(host, 'url') as seg, i (i)}{#if i > 0}<wbr />{/if}<span class="inline-block max-w-full break-all font-medium text-text">{seg}</span>{/each}{#each valueSegments(rest, 'url').filter((s) => s !== '') as seg, i (i)}<wbr /><span class="inline-block max-w-full break-all">{seg}</span>{/each}</span>
