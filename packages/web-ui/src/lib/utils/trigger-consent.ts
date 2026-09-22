/**
 * Whether a trigger is held back until a person confirms it: an agent run
 * (`effect: 'run_agent'`) with no `confirmed_at`. The engine's scheduler skips
 * such a trigger and otherwise leaves it as it is — still enabled, its
 * `next_run_at` kept — so that confirming makes it due in place. Nothing else in
 * the payload tells it apart from a trigger that runs, which is why the view
 * asks this instead of reading `enabled` or `next_run_at`.
 *
 * Not every consent in the product is this one: a workflow trigger carries its
 * confirmation on the workflow, which `executePipeline` checks when the run
 * starts. That one is not visible in this payload and is not what this answers.
 *
 * `trigger-consent.test.ts` holds this against the scheduler's own query, so a
 * change to which triggers wait for consent fails there instead of leaving the
 * view showing the old rule.
 */
export function awaitsConfirmation(trigger: {
	effect?: string | undefined;
	confirmed_at?: string | null | undefined;
}): boolean {
	return trigger.effect === 'run_agent' && !trigger.confirmed_at;
}

/**
 * Bidi overrides and marks — they render text in an order it is not written in —
 * plus the zero-width formatters, which put characters where a reader sees none.
 */
const FORGING_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/**
 * The C0/C1 ranges and the Unicode separators, but NOT tab and newline: the text
 * this cleans is an instruction written over several lines, and its line breaks
 * are content.
 */
// eslint-disable-next-line no-control-regex -- removing them is the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * What a person reads before they allow a run: strip what forges rather than
 * fills, keep everything that carries meaning.
 *
 * The same class the chat's own framing defence removes (`chat-framing.ts`,
 * `prompt-origin.ts`), for the same reason and one step earlier: this text was
 * written by the agent and can quote content the agent read somewhere else, and
 * it is shown next to a button that grants an unattended run. A right-to-left
 * override can make an instruction read as its own opposite, and a zero-width
 * run can hide a clause inside a sentence that looks complete.
 *
 * Deliberately NOT `sanitizeFramingField`: that one collapses every whitespace
 * run to a single space and clamps, which is right for a one-line seed message
 * and wrong here — it would turn the instruction into a wall of text and cut it
 * off, and what is cut off is exactly what someone hides at the end.
 *
 * Escaping is Svelte's job and this does not replace it; the template renders
 * text, never `{@html}`.
 */
export function displaySafe(text: string): string {
	return text.replace(FORGING_CHARS, '').replace(CONTROL_CHARS, '');
}

/**
 * What an agent run is told to do, as the engine composes it.
 *
 * `executeStandard` builds `Task: <title>\n\n<description>` and drops the
 * description when it only repeats the title — so a trigger without one runs on
 * its title alone, and then the title IS the instruction. The list shows titles
 * clipped to two lines, which is why this returns the whole thing for the
 * consent block rather than the description by itself.
 */
export function instructionOf(trigger: { title: string; description?: string | undefined }): string {
	const description = trigger.description?.trim() ?? '';
	if (description === '' || description === trigger.title.trim()) return trigger.title;
	return `${trigger.title}\n\n${description}`;
}

/**
 * The page a watch trigger reads, out of its stored config.
 *
 * A watch does not run the text above: `executeWatch` builds its prompt from
 * this URL and from what it fetched there, and never reads title or
 * description. Confirming one without seeing the address would be consent to a
 * repeated fetch of a page the view never showed.
 *
 * `watch_config` is JSON that reaches here as a string from the wire; anything
 * that is not an object with a non-empty string `url` yields nothing, and the
 * block that shows it disappears rather than rendering an empty label.
 */
export function watchUrlOf(trigger: { watch_config?: string | undefined }): string | undefined {
	if (!trigger.watch_config) return undefined;
	try {
		const url = (JSON.parse(trigger.watch_config) as { url?: unknown }).url;
		return typeof url === 'string' && url !== '' ? url : undefined;
	} catch {
		return undefined;
	}
}
