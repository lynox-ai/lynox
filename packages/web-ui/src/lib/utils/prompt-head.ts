/**
 * The engine's own confirmation opens with text the system wrote (the tool or action, e.g.
 * "⚠ Command: delete files (cannot be undone) — \"") and goes on with the value it asks about,
 * which can run to many lines. With little height only the value scrolls: the head stays above
 * it, so a person always sees what kind of action they are deciding, however far they scrolled.
 *
 * The head is the run of frame segments before the first value. Without segments (an older
 * engine), or without a value after the frame (a question that is all system text), there is no
 * head to keep apart and the whole question scrolls as one. A short one-line value stays on the
 * head's line, as it always did: kept apart it would cost a line, and a short question cannot
 * scroll its head away.
 */
const INLINE_VALUE_MAX = 160;

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
	const firstValue = segments ? segments.findIndex((s) => s.kind === 'value') : -1;
	if (!segments || firstValue <= 0) return { head: '', lines: question.split('\n') };
	const head = segments.slice(0, firstValue).map((s) => s.text).join('');
	const body = segments.slice(firstValue).map((s) => s.text).join('');
	if (!body.includes('\n') && question.length <= INLINE_VALUE_MAX) return { head: '', lines: [question] };
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
 */
export function promptFieldTooLow(field: { clientHeight: number; scrollHeight: number }, over: number, lineHeight: number): boolean {
	const room = field.clientHeight - Math.max(0, over);
	return field.scrollHeight > room + 1 && room < 4 * lineHeight - 1;
}
