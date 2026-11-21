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
	/** The system-written opening that never scrolls; empty when there is none. */
	head: string;
	/** Everything from the first value on, as the lines the field shows and counts. */
	lines: string[];
}

interface Segment {
	kind: 'frame' | 'value';
	text: string;
}

export function splitPromptHead(question: string, segments: readonly Segment[] | undefined): PromptSplit {
	const firstLong = segments ? segments.findIndex((s) => s.kind === 'value' && (s.text.includes('\n') || s.text.length > LONG_VALUE)) : -1;
	if (!segments || firstLong <= 0) return { head: '', lines: question.split('\n') };
	const head = segments.slice(0, firstLong).map((s) => s.text).join('');
	const body = segments.slice(firstLong).map((s) => s.text).join('');
	return { head, lines: body.split('\n') };
}

/**
 * How many of the field's lines are not wholly in view: a line counts while its bottom edge lies
 * below the field's bottom edge, so a line cut in half still counts. Lines are the value's own
 * lines, each its own block, so a line the browser wraps counts once.
 */
export function linesBelow(lineBottoms: readonly number[], fieldBottom: number): number {
	let n = 0;
	for (const bottom of lineBottoms) if (bottom > fieldBottom + 0.5) n++;
	return n;
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
