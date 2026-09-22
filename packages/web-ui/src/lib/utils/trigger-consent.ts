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
 * A waiting trigger whose run really carries out the text this view can show.
 *
 * The dispatch switches on the EFFECT first, and inside `run_agent` it picks the
 * executor by SOURCE — `worker-loop.ts`, an `if (task.source === 'watch')` that
 * calls `executeWatch`, else `executeStandard`. A watch runs on the page it
 * fetches, so the instruction below never reaches it. So the consent surface offers the instruction and the button only where
 * the instruction is the truth; a watch shows its waiting state and nothing it
 * would not do. Showing it the same block would be a consent to a text the run
 * ignores, which is worse than showing nothing.
 */
export function showsInstruction(trigger: {
	effect?: string | undefined;
	source?: string | undefined;
	confirmed_at?: string | null | undefined;
}): boolean {
	return awaitsConfirmation(trigger) && trigger.source !== 'watch';
}

/**
 * The address a waiting watch would fetch, when the view can actually show it.
 *
 * A watch is confirmed on its TARGET, not on an instruction it never receives,
 * so the consent needs the address — and if the stored config cannot be read,
 * there is nothing to consent to and the block falls back to the waiting state
 * alone. Saying "confirm this" over an address the view could not produce would
 * be the same mistake as showing a watch the instruction text.
 */
export function showsWatchTarget(trigger: {
	effect?: string | undefined;
	source?: string | undefined;
	confirmed_at?: string | null | undefined;
	watch_config?: string | undefined;
}): boolean {
	return awaitsConfirmation(trigger) && trigger.source === 'watch' && watchOf(trigger) !== undefined;
}

/**
 * Whether the block may offer the button at all — ONE gate, so the button
 * cannot outlive the thing it consents to. Each side has its own display and
 * its own test; this is where they meet.
 */
export function offersConfirmation(trigger: {
	effect?: string | undefined;
	source?: string | undefined;
	confirmed_at?: string | null | undefined;
	watch_config?: string | undefined;
}): boolean {
	return showsInstruction(trigger) || showsWatchTarget(trigger);
}

/**
 * Characters that put text where a reader sees none, or render a run in an order
 * it is not written in: the bidi embeddings, overrides and isolates, the
 * zero-width and invisible-format characters, and the TAG block, which encodes a
 * whole second sentence in characters no font draws.
 *
 * The tag block matters most here and was missed once: the run reads
 * `description` raw, so a tagged clause reaches the model while the box shows a
 * short, harmless-looking instruction — the same gap as an instruction the run
 * never receives, only inverted.
 *
 * What is deliberately NOT here, and the omission is the considered half:
 * · LRM/RLM (U+200E/200F) — legitimate in right-to-left text, where they order
 *   digits and punctuation around a word. `chat-framing.ts` leaves them for the
 *   same reason and states the trade: the overrides buy an attacker the actual
 *   reversal, the marks only nudge neutrals.
 * · ZWJ/ZWNJ (U+200D/200C) — these belong to the words, not to the framing.
 *   Stripping ZWJ splits an emoji family into three people; stripping ZWNJ turns
 *   the Persian `\u0645\u06CC\u200C\u0631\u0648\u062F` into a different word.
 *   `prompt-origin.ts` does strip them, because its field is a short workflow
 *   label and never prose; this one is prose someone has to read and act on.
 * · Variation selectors and combining marks — they change how a visible
 *   character is drawn, and removing them damages emoji and half the alphabets
 *   that are not Latin.
 *
 * Not a complete answer to "reads as its opposite": natural right-to-left prose
 * reorders neutral characters with no control character at all, and nothing in
 * this package sets `dir`. That is a wider gap than this block.
 */
const FORGING_CHARS = /[\u00AD\u061C\u180E\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;
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
 * Narrower than the chat's own two framing defences and for a stated reason (see
 * `FORGING_CHARS`): this text is prose in whatever language it was written in,
 * and it is shown next to a button that grants an unattended run. A
 * right-to-left override can make an instruction read as its own opposite, and
 * an invisible space can hide a clause inside a sentence that looks complete —
 * those go. The characters a language needs to spell its own words stay.
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
 * this URL and from what it fetched there (*"You are monitoring <url> for
 * changes"*), and the description reaches it nowhere. The title appears only
 * afterwards, as the heading of the notification. Confirming a watch without
 * seeing the address would be consent to a repeated fetch of a page the view
 * never showed.
 *
 * `watch_config` is JSON that reaches here as a string from the wire; anything
 * that is not an object with a non-empty string `url` yields nothing, and the
 * block that shows it disappears rather than rendering an empty label.
 */
export function watchOf(trigger: { watch_config?: string | undefined }):
	{ url: string; intervalMinutes?: number | undefined } | undefined {
	if (!trigger.watch_config) return undefined;
	try {
		const config = JSON.parse(trigger.watch_config) as { url?: unknown; interval_minutes?: unknown };
		if (typeof config.url !== 'string' || config.url === '') return undefined;
		// A model-authored "url" is a string of any length, and `break-all` would
		// wrap it into a wall that pushes the button off the screen — the failure
		// `prompt-origin.ts` names: the person cannot see what they are agreeing
		// to. Cut on code points so an emoji or a surrogate pair is not halved.
		const chars = [...config.url];
		const url = chars.length > URL_DISPLAY_MAX ? `${chars.slice(0, URL_DISPLAY_MAX - 1).join('')}…` : config.url;
		return typeof config.interval_minutes === 'number' && Number.isFinite(config.interval_minutes)
			? { url, intervalMinutes: config.interval_minutes }
			: { url };
	} catch {
		return undefined;
	}
}

/** Long enough for a real URL with a path, short enough to leave the button on screen. */
const URL_DISPLAY_MAX = 160;
