<script lang="ts">
	import { t } from '../i18n.svelte.js';

	interface Props {
		value: string;
		onChange: (q: string) => void;
	}

	const { value, onChange }: Props = $props();

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	// Initialise local mirror once; subsequent parent-driven changes flow via
	// onChange so we don't need to re-sync the input element here.
	let local = $state('');
	$effect(() => {
		local = value;
	});

	function handleInput(e: Event): void {
		local = (e.target as HTMLInputElement).value;
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => onChange(local), 300);
	}

	function clear(): void {
		local = '';
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		onChange('');
	}
</script>

<div class="mb-3 relative">
	<input
		type="search"
		value={local}
		oninput={handleInput}
		placeholder={t('inbox.search_placeholder')}
		class="w-full rounded-[var(--radius-md)] border border-border bg-bg-subtle px-3 py-2 pr-8 text-sm text-text placeholder:text-text-subtle focus:outline-none focus:border-border-hover"
		aria-label={t('inbox.search_placeholder')}
	/>
	{#if local.length > 0}
		<button
			type="button"
			class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-text-subtle hover:text-text px-1"
			onclick={clear}
			aria-label={t('inbox.search_clear')}
		>×</button>
	{/if}
</div>
