<script lang="ts" module>
	const SIZE_CLASS = { sm: 'h-3.5 w-3.5', md: 'h-4 w-4' } as const;
</script>

<script lang="ts">
	interface Props {
		checked?: boolean;
		disabled?: boolean;
		ariaLabel?: string;
		// Click handler instead of bind:checked when callers need access to the
		// raw event (e.g. shift-click for range-select in InboxView).
		onclick?: (event: MouseEvent) => void;
		// Optional id for label-binding — leave empty when the checkbox sits
		// inside a <label> that wraps it.
		id?: string;
		size?: keyof typeof SIZE_CLASS;
	}

	let {
		checked = $bindable(false),
		disabled = false,
		ariaLabel,
		onclick,
		id,
		size = 'md',
	}: Props = $props();

	const sizeClass = $derived(SIZE_CLASS[size]);
</script>

<input
	type="checkbox"
	{id}
	bind:checked
	{disabled}
	aria-label={ariaLabel}
	{onclick}
	class="lynox-checkbox shrink-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 {sizeClass}"
/>

<style>
	/* Override default platform styling to match the dark theme. Native
	   checkboxes render with browser-themed white squares + ✓ glyph that
	   clash hard on bg #050510. We style the box ourselves and draw a
	   custom checkmark via CSS mask. */
	.lynox-checkbox {
		appearance: none;
		-webkit-appearance: none;
		background-color: var(--color-bg-subtle);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-sm);
		display: inline-block;
		position: relative;
		transition: background-color 120ms, border-color 120ms;
	}
	.lynox-checkbox:hover:not(:disabled) {
		border-color: var(--color-border-hover);
	}
	.lynox-checkbox:focus-visible {
		outline: 2px solid var(--color-accent-text);
		outline-offset: 2px;
	}
	.lynox-checkbox:checked {
		background-color: var(--color-accent);
		border-color: var(--color-accent);
	}
	.lynox-checkbox:checked::after {
		content: '';
		position: absolute;
		inset: 0;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none'%3E%3Cpath d='M3 8l3.5 3.5L13 5' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
		background-size: contain;
		background-position: center;
		background-repeat: no-repeat;
	}
</style>
