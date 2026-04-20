<script lang="ts">
	import { getToasts, dismissToast } from '../stores/toast.svelte.js';

	const toasts = $derived(getToasts());
</script>

{#if toasts.length > 0}
	<div class="fixed bottom-4 right-4 left-4 sm:left-auto z-50 space-y-2 sm:max-w-sm">
		{#each toasts as toast (toast.id)}
			<div
				class="rounded-[var(--radius-md)] px-4 py-3 text-sm shadow-lg transition-all animate-in flex items-start gap-3
				{toast.type === 'success' ? 'bg-success/15 border border-success/30 text-success' :
				 toast.type === 'error' ? 'bg-danger/15 border border-danger/30 text-danger' :
				 'bg-bg-subtle border border-border text-text-muted'}"
			>
				<span class="flex-1">{toast.message}</span>
				{#if toast.action}
					{@const action = toast.action}
					<button
						type="button"
						onclick={() => { action.handler(); dismissToast(toast.id); }}
						class="shrink-0 rounded-[var(--radius-sm)] border border-current/40 px-2 py-1 text-xs font-medium hover:bg-current/10 transition-colors"
					>
						{action.label}
					</button>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.animate-in {
		animation: slideIn 0.2s ease-out;
	}
	@keyframes slideIn {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}
</style>
