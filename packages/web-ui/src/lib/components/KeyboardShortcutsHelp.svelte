<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from '../i18n.svelte.js';

	interface Props {
		open: boolean;
		onClose: () => void;
	}
	const { open, onClose }: Props = $props();

	let dialogRef = $state<HTMLDivElement | null>(null);

	const rows: ReadonlyArray<{ keys: string[]; label: string }> = [
		{ keys: ['J', '↓'], label: 'inbox.shortcuts_next' },
		{ keys: ['K', '↑'], label: 'inbox.shortcuts_prev' },
		{ keys: ['A'], label: 'inbox.shortcuts_archive' },
		{ keys: ['S'], label: 'inbox.shortcuts_snooze' },
		{ keys: ['Z'], label: 'inbox.shortcuts_undo' },
		{ keys: ['Esc'], label: 'inbox.shortcuts_close' },
		{ keys: ['?'], label: 'inbox.shortcuts_help' },
	];

	onMount(() => {
		// Focus the dialog so the host's Esc handler dispatches close even
		// when the trigger button was the prior focus owner.
		if (open && dialogRef) dialogRef.focus();
	});

	$effect(() => {
		if (open && dialogRef) dialogRef.focus();
	});
</script>

{#if open}
	<div
		class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4"
		role="presentation"
		onclick={onClose}
	>
		<div
			bind:this={dialogRef}
			role="dialog"
			aria-modal="true"
			aria-labelledby="shortcuts-help-title"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}
			class="bg-bg-subtle border border-border shadow-xl max-w-md w-full p-6 outline-none rounded-t-[var(--radius-lg)] sm:rounded-[var(--radius-lg)] pb-[max(1.5rem,env(safe-area-inset-bottom))]"
		>
			<div class="flex items-start justify-between gap-3 mb-3">
				<h2 id="shortcuts-help-title" class="text-base font-medium tracking-tight">
					{t('inbox.shortcuts_title')}
				</h2>
				<button
					type="button"
					onclick={onClose}
					aria-label={t('inbox.shortcuts_close_button')}
					class="text-text-subtle hover:text-text text-sm leading-none p-2 -mr-1 -mt-1 min-h-[32px] pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]"
				>×</button>
			</div>
			<p class="text-[12px] text-text-muted mb-4">{t('inbox.shortcuts_intro')}</p>
			<dl class="space-y-2">
				{#each rows as row (row.label)}
					<div class="flex items-center justify-between gap-4">
						<dt class="text-sm text-text">{t(row.label)}</dt>
						<dd class="flex items-center gap-1 shrink-0">
							{#each row.keys as key, i (key)}
								{#if i > 0}<span class="text-text-subtle text-[11px]">/</span>{/if}
								<kbd class="rounded-[var(--radius-sm)] bg-bg-muted border border-border text-text-muted text-[11px] font-mono px-1.5 py-0.5 min-w-[1.5rem] text-center">{key}</kbd>
							{/each}
						</dd>
					</div>
				{/each}
			</dl>
			<p class="text-[11px] text-text-subtle mt-4 pt-3 border-t border-border">
				{t('inbox.shortcuts_pending')}
			</p>
		</div>
	</div>
{/if}
