<script lang="ts">
	import type { Snippet } from 'svelte';

	let { panelContent, onClose }: { panelContent?: Snippet; onClose?: () => void } = $props();

	let pinned = $state(false);
</script>

{#if panelContent}
	<aside class="w-80 shrink-0 border-l border-border bg-bg-subtle overflow-y-auto hidden lg:flex flex-col">
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-2 border-b border-border">
			<button
				onclick={() => { pinned = !pinned; }}
				class="text-xs font-mono text-text-subtle hover:text-text transition-colors"
				aria-label={pinned ? 'Unpin' : 'Pin'}
			>
				{pinned ? '📌' : '📍'}
			</button>
			{#if onClose}
				<button
					onclick={onClose}
					class="text-xs text-text-subtle hover:text-text transition-colors"
					aria-label="Close panel"
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
						<path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
					</svg>
				</button>
			{/if}
		</div>

		<!-- Content -->
		<div class="flex-1 p-4">
			{@render panelContent()}
		</div>
	</aside>
{/if}
