// The foot of a review dialog (stamp, takeover): its buttons stay in sight at the bottom of the
// scrolling frame, on an opaque ground with a line above, so the review never scrolls them away.
// Only where the frame is high enough; lower (a phone held sideways, a page zoomed in), the
// whole frame scrolls and the buttons come last, as before. Their labels are fixed words, so the
// foot cannot grow past the frame. Same query as DialogStatusLine.svelte.
export const DIALOG_FOOT_CLASS =
	'flex items-center justify-end gap-2 mt-5 -mx-5 -mb-5 px-5 pt-3 pb-5 bg-bg border-border ' +
	'[@media(min-height:30rem)]:sticky [@media(min-height:30rem)]:-bottom-5 [@media(min-height:30rem)]:z-10 [@media(min-height:30rem)]:border-t';

// The height a part takes over the review while it stays in sight; 0 while it scrolls with it.
function heldHeight(part: HTMLElement | null): number {
	if (part === null || typeof getComputedStyle !== 'function') return 0;
	return getComputedStyle(part).position === 'sticky' ? part.getBoundingClientRect().height : 0;
}

/**
 * Keeps what scrolls into view in the frame clear of the parts that stay in sight: the frame's
 * scroll padding is their height, read from the frame as rendered now. Browsers apply it when
 * focus moves (Tab) and to `scrollIntoView`.
 */
export function syncScrollPadding(frame: HTMLElement): void {
	const top = heldHeight(frame.querySelector<HTMLElement>(':scope > [data-dialog-status]'));
	const foot = heldHeight(frame.querySelector<HTMLElement>(':scope > [data-dialog-foot]'));
	frame.style.scrollPaddingTop = top > 0 ? `${top + 8}px` : '';
	frame.style.scrollPaddingBottom = foot > 0 ? `${foot + 8}px` : '';
}

/**
 * Holds the frame's scroll padding while the dialog is open: again when the frame or one of its
 * parts changes size (the window, a status line opened), and when the status line comes or goes.
 * Returns the cleanup.
 */
export function holdScrollPadding(frame: HTMLElement): () => void {
	const sync = (): void => syncScrollPadding(frame);
	const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
	const watchParts = (): void => {
		if (sizes === null) return;
		sizes.disconnect();
		sizes.observe(frame);
		for (const part of frame.querySelectorAll<HTMLElement>(':scope > [data-dialog-status], :scope > [data-dialog-foot]')) sizes.observe(part);
	};
	watchParts();
	sync();
	const parts = typeof MutationObserver === 'function' ? new MutationObserver(() => { watchParts(); sync(); }) : null;
	parts?.observe(frame, { childList: true });
	return () => { sizes?.disconnect(); parts?.disconnect(); };
}

/** Brings a marked part of the review into sight below the status line and above the foot. */
export function bringIntoReview(frame: HTMLElement, el: HTMLElement): void {
	syncScrollPadding(frame);
	el.scrollIntoView?.({ block: 'nearest' });
}
