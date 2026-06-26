// === scrollFade Svelte action ===
//
// Adds an edge fade-mask to a horizontally-scrollable container so the user
// gets a visual cue that content continues off-edge. Our tab rows / status bar
// use `scrollbar-none`, so without this they scroll-trap silently — there is no
// scrollbar and no hint that swiping reveals more. The mask fades whichever edge
// can still be scrolled toward; a fully-in-view row shows no fade at all.
//
// Usage:  <div class="overflow-x-auto scrollbar-none" use:scrollFade> ... </div>

const FADE_PX = 16;

/**
 * The `mask-image` gradient for a given scroll position, or `null` when the
 * content fully fits (no fade). Pure + DOM-free so it is unit-testable; the
 * action below is the thin DOM wrapper. The 1px slack absorbs sub-pixel
 * rounding so a fully-scrolled edge doesn't keep a phantom fade.
 */
export function computeScrollFadeMask(
	scrollLeft: number,
	scrollWidth: number,
	clientWidth: number,
): string | null {
	const maxScroll = scrollWidth - clientWidth;
	const canLeft = scrollLeft > 1;
	const canRight = scrollLeft < maxScroll - 1;
	if (!canLeft && !canRight) return null;
	const left = canLeft ? 'transparent' : 'black';
	const right = canRight ? 'transparent' : 'black';
	return `linear-gradient(to right, ${left} 0, black ${FADE_PX}px, black calc(100% - ${FADE_PX}px), ${right} 100%)`;
}

export function scrollFade(node: HTMLElement): { destroy: () => void } {
	function apply(mask: string | null): void {
		if (mask === null) {
			node.style.removeProperty('mask-image');
			node.style.removeProperty('-webkit-mask-image');
			return;
		}
		node.style.setProperty('mask-image', mask);
		node.style.setProperty('-webkit-mask-image', mask);
	}
	function update(): void {
		apply(computeScrollFadeMask(node.scrollLeft, node.scrollWidth, node.clientWidth));
	}
	update();
	node.addEventListener('scroll', update, { passive: true });
	// Re-evaluate when the container (or its content) is resized — the fade
	// depends on clientWidth, which changes with the viewport / drawer.
	const ro = new ResizeObserver(update);
	ro.observe(node);
	return {
		destroy(): void {
			node.removeEventListener('scroll', update);
			ro.disconnect();
		},
	};
}
