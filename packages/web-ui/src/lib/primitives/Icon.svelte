<script lang="ts" module>
	// Hoisted so each <Icon> instance reuses the same map instead of
	// reallocating it per reactive run (AppShell alone renders ~10 icons).
	const SIZE_CLASS = { xs: 'h-3 w-3', sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' } as const;
</script>

<script lang="ts">
	import { icons, type IconName } from './icons.js';

	interface Props {
		name: IconName;
		// xs/sm/md/lg map to 12/16/20/24 px to keep callsites visually consistent.
		size?: keyof typeof SIZE_CLASS;
		// Omit ariaLabel for decorative icons — the component sets aria-hidden
		// itself so adjacent text labels keep their announce-once semantics.
		ariaLabel?: string;
		class?: string;
	}

	const { name, size = 'sm', ariaLabel, class: extraClass = '' }: Props = $props();

	const sizeClass = $derived(SIZE_CLASS[size]);
	const path = $derived(icons[name]);
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	class="shrink-0 {sizeClass} {extraClass}"
	fill="none"
	viewBox="0 0 24 24"
	stroke="currentColor"
	stroke-width="1.5"
	role={ariaLabel ? 'img' : undefined}
	aria-label={ariaLabel}
	aria-hidden={ariaLabel ? undefined : true}
>
	{@html path}
</svg>
