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
 * Brings a marked part of the review into sight below the status line and above the foot, so
 * neither covers it. What stays in sight is read from the dialog as rendered now.
 */
export function bringIntoReview(dialog: HTMLElement, el: HTMLElement): void {
	const top = heldHeight(dialog.querySelector<HTMLElement>('[data-dialog-status]'));
	const foot = heldHeight(dialog.querySelector<HTMLElement>('[data-dialog-foot]'));
	el.style.scrollMarginTop = `${top + 8}px`;
	el.style.scrollMarginBottom = `${foot + 8}px`;
	el.scrollIntoView?.({ block: 'nearest' });
}
