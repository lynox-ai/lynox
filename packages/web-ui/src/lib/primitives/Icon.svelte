<script lang="ts">
	import { icons, type IconName } from './icons.js';

	interface Props {
		name: IconName;
		size?: 'xs' | 'sm' | 'md' | 'lg';
		// Accessible label. When omitted the icon is treated as decorative
		// (aria-hidden=true) — fine when an adjacent <span> already labels
		// the affordance.
		ariaLabel?: string;
		class?: string;
	}

	const { name, size = 'sm', ariaLabel, class: extraClass = '' }: Props = $props();

	// xs/sm/md/lg map to 12/16/20/24 px to keep callsites visually consistent.
	const sizeClass = $derived({ xs: 'h-3 w-3', sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' }[size]);

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
