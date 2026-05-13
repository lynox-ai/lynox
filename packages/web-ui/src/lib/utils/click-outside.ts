// === click-outside Svelte action ===
//
// Closes a popover / menu when the user clicks anywhere outside the
// element the action is bound to. Listens on `mousedown` so the close
// fires before any inner click handler runs (matches native menu UX).
//
// Usage:
//   <div use:clickOutside={() => (open = false)}>...</div>

export function clickOutside(
	node: HTMLElement,
	onOutside: () => void,
): { destroy: () => void } {
	function handle(event: MouseEvent): void {
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (!node.contains(target)) onOutside();
	}
	document.addEventListener('mousedown', handle, true);
	return {
		destroy: (): void => {
			document.removeEventListener('mousedown', handle, true);
		},
	};
}
