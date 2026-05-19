<!--
	3-state theme toggle ('system' | 'light' | 'dark') as a WAI-ARIA-compliant
	radiogroup with roving-tabindex + arrow-key navigation. Used inside
	AccountAppearanceView; reusable for future surfaces (mobile drawer etc.).
-->
<script lang="ts">
	import { getThemeMode, setThemeMode, type ThemeMode } from '$lib/stores/theme.svelte.js';
	import { t } from '$lib/i18n.svelte.js';

	const options: { value: ThemeMode; labelKey: string }[] = [
		{ value: 'system', labelKey: 'theme.system' },
		{ value: 'light', labelKey: 'theme.light' },
		{ value: 'dark', labelKey: 'theme.dark' },
	];

	const current = $derived(getThemeMode());
	let buttons: HTMLButtonElement[] = $state([]);

	function focusIndex(idx: number): void {
		const wrapped = ((idx % options.length) + options.length) % options.length;
		const btn = buttons[wrapped];
		if (!btn) return;
		setThemeMode(options[wrapped]!.value);
		btn.focus();
	}

	function onKeydown(e: KeyboardEvent, idx: number): void {
		switch (e.key) {
			case 'ArrowRight':
			case 'ArrowDown':
				e.preventDefault();
				focusIndex(idx + 1);
				break;
			case 'ArrowLeft':
			case 'ArrowUp':
				e.preventDefault();
				focusIndex(idx - 1);
				break;
			case 'Home':
				e.preventDefault();
				focusIndex(0);
				break;
			case 'End':
				e.preventDefault();
				focusIndex(options.length - 1);
				break;
		}
	}
</script>

<div
	role="radiogroup"
	aria-label={t('theme.heading')}
	class="inline-flex border border-border rounded-[var(--radius-md)] overflow-hidden"
>
	{#each options as opt, idx}
		<button
			type="button"
			role="radio"
			aria-checked={current === opt.value}
			tabindex={current === opt.value ? 0 : -1}
			bind:this={buttons[idx]}
			onclick={() => setThemeMode(opt.value)}
			onkeydown={(e) => onKeydown(e, idx)}
			class="px-3 py-1.5 text-sm transition-colors {current === opt.value
				? 'bg-accent/10 text-accent-text'
				: 'text-text-muted hover:bg-bg-subtle'}"
		>
			{t(opt.labelKey)}
		</button>
	{/each}
</div>
