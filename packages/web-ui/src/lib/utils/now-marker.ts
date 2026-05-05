/**
 * Per-turn `[Now: …]` marker handling.
 *
 * The engine prepends `[Now: <iso>; user local <local> <tz>]\n\n` to every
 * user message before sending it to the LLM (see core `withCurrentTimePrefix`).
 * It's invisible context for the model, but the run-history record stores
 * the full task as-sent — so when the chat UI replays a thread the marker
 * shows up inside the user's bubble. This helper strips it at render time
 * so the user sees only their own words.
 *
 * Pattern matches the pre-PR-#246 form (`[Now: 2026-05-05T11:55:00.123Z]`)
 * AND the post-#246 form with the local clause
 * (`[Now: 2026-05-05T11:55:00.123Z; user local 2026-05-05 13:55:00 Europe/Zurich]`).
 * Trailing `\n\n` is consumed too — that's the separator the engine writes,
 * not part of the user's text.
 */
const NOW_MARKER_AT_START = /^\[Now:[^\]\n]*\](?:\n\n|\n)?/;

export function stripNowMarker(text: string | undefined | null): string {
	if (typeof text !== 'string') return '';
	return text.replace(NOW_MARKER_AT_START, '');
}
