/**
 * The engine's own confirmation opens with text the system wrote (the tool or action, e.g.
 * "⚠ Command: delete files (cannot be undone) — \"") and goes on with the value it asks about,
 * which can run to many lines. With little height only the value scrolls: the head stays above
 * it, so a person always sees what kind of action they are deciding, however far they scrolled.
 *
 * The head runs up to the first LONG value: one with a line break, or longer than a line. Short
 * values before it stay in the head, so an external tool's name (a short value between frames)
 * does not cut the head off before the action it names. Without segments (an older engine), or
 * without a long value (a question that is short, or all system text), there is no head to keep
 * apart: the question shows as one, as it always did.
 */
const LONG_VALUE = 80;

export interface PromptSplit {
	/** The opening that never scrolls, as its segments: a short value in it stays a value. Empty
	 *  when there is none. */
	head: Segment[];
	/** Everything from the first value on, as the lines the field shows and counts. */
	lines: string[];
}

export interface Segment {
	kind: 'frame' | 'value';
	text: string;
}

export function splitPromptHead(question: string, segments: readonly Segment[] | undefined): PromptSplit {
	const firstLong = segments ? segments.findIndex((s) => s.kind === 'value' && (s.text.includes('\n') || s.text.length > LONG_VALUE)) : -1;
	if (!segments || firstLong <= 0) return { head: [], lines: question.split('\n') };
	const head = segments.slice(0, firstLong).map((s) => ({ kind: s.kind, text: s.text }));
	const body = segments.slice(firstLong).map((s) => s.text).join('');
	return { head, lines: body.split('\n') };
}

/**
 * How much of the value is not yet in view, in lines. Each of the value's own lines that runs past
 * the field's bottom edge counts with the screen lines it still hides there, rounded up, and at
 * least one: a line cut in half counts, a short line below counts once, and a long line (a path
 * the browser wraps over many screen lines) counts every screen line it hides, so the end of a
 * long value cannot hide behind a "1".
 */
export function linesBelow(lineBoxes: readonly { top: number; bottom: number }[], fieldBottom: number, lineHeight: number): number {
	let n = 0;
	for (const { top, bottom } of lineBoxes) {
		if (bottom <= fieldBottom + 0.5) continue;
		const hidden = bottom - Math.max(top, fieldBottom);
		n += Math.max(1, Math.ceil((hidden - 0.5) / lineHeight));
	}
	return n;
}

/**
 * How far the content of a scrolled box reaches below its visible part, in pixels, for a box whose
 * lines are not elements of their own (rendered markup). Measured where the content ends — the
 * bottom of its last element, `contentBottom` — so a trailing margin, which scrolls but holds no
 * text, is not counted; never more than is left to scroll. `contentBottom` is null when the content
 * does not end in an element (text after the last one): then what is left to scroll is taken.
 */
export function contentLeftBelow(box: { scrollHeight: number; clientHeight: number; scrollTop: number; bottom: number }, contentBottom: number | null): number {
	const toScroll = box.scrollHeight - box.clientHeight - box.scrollTop;
	return contentBottom === null ? toScroll : Math.min(toScroll, contentBottom - box.bottom);
}

/** The nodes `contentBottomOf` reads: a box's last child and its siblings before it. */
export interface TailNode {
	nodeType: number;
	textContent: string | null;
	previousSibling: TailNode | null;
	getBoundingClientRect?: () => { bottom: number };
}

/**
 * Where a box's content ends, for `contentLeftBelow`: the bottom of its last element, passing over
 * text that is only whitespace (rendered markup ends in a line break). Null when text follows the
 * last element, or there is none: then what is left to scroll is taken.
 */
export function contentBottomOf(lastChild: TailNode | null): number | null {
	let tail = lastChild;
	while (tail && tail.nodeType === 3 && (tail.textContent ?? '').trim() === '') tail = tail.previousSibling;
	return tail && tail.nodeType === 1 && tail.getBoundingClientRect ? tail.getBoundingClientRect().bottom : null;
}

/**
 * How many lines `left` pixels of content below a box's edge are, rounded up so a cut line counts.
 * 0 below one pixel: the sizes are rounded pixels and the scroll position is not, so fractional
 * zoom leaves up to a pixel at the very end. Any more, and part of a line is hidden.
 */
export function linesLeftBelow(left: number, lineHeight: number): number {
	if (left < 1) return 0;
	return Math.max(1, Math.ceil(left / Math.max(1, lineHeight) - 0.01));
}

/**
 * How far one "read more" scrolls a box of `clientHeight` with a fade of `fadeHeight` at its
 * bottom: by the whole lines seen above the fade, at least one. The line under the fade, or cut
 * by the edge, is then on screen after; no line is passed over.
 */
export function readOnStep(clientHeight: number, lineHeight: number, fadeHeight: number): number {
	const line = Math.max(1, lineHeight);
	return Math.max(1, Math.floor((clientHeight - fadeHeight) / line)) * line;
}

/**
 * Whether the field has too little room to show about four lines once it shrinks with the window.
 * Then the card keeps its own height and the stack scrolls instead, buttons included: the question
 * wins over the buttons. `over` is how far the stack's content runs past its visible part.
 * The room is measured one way in each state, and the two can differ by a rounded pixel or two, so
 * the state changes only a margin past four lines: at one window height it never flips back and
 * forth.
 */
const TOO_LOW_MARGIN = 4;
export function promptFieldTooLow(field: { clientHeight: number; scrollHeight: number }, over: number, lineHeight: number, wasTooLow: boolean): boolean {
	const room = field.clientHeight - Math.max(0, over);
	if (field.scrollHeight <= room + 1) return false;
	const four = 4 * lineHeight;
	return wasTooLow ? room < four + TOO_LOW_MARGIN : room < four - TOO_LOW_MARGIN;
}
