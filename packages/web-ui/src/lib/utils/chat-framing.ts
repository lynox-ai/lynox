/**
 * Helpers for the "💬 … im Chat" affordances that open a fresh chat seeded with
 * a first message composed from a domain object (a contact, an API profile, a
 * task). The agent then loads + edits that object through its own tools
 * (contacts_search/save, api_setup, task_update) — the chat IS the editor, so
 * there is no bespoke form. The message is composed CLIENT-SIDE here, which is
 * why the injection defence also lives here (see sanitizeFramingField).
 */

/**
 * Client-side mirror of the engine's chat-context `oneLine()` sanitiser
 * (`src/core/chat-context.ts`). Some fields we interpolate into the seed message
 * are EXTERNALLY authored — a contact's name/email can originate from an inbound
 * sender, an import, or a sync — so a crafted value carrying an embedded newline
 * plus a fake `[System: …]` line could inject a pseudo-system directive into the
 * task text we send to the agent. Because the message is composed on the client,
 * the defence belongs on the client: collapse every whitespace char plus the C0
 * + DEL + C1 control ranges to a single space, then clamp the length.
 *
 * The class `[\s\x00-\x1f\x7f-\x9f]` covers all whitespace (incl. the Unicode
 * line/paragraph separators U+2028/U+2029 and NBSP via `\s`), the C0 range + DEL,
 * AND the C1 range `\x80-\x9f` — which contains U+0085 (NEL), a line break that
 * `\s` and the C0 class both miss. This matches the server sanitiser byte-for-byte
 * so the two layers behave identically.
 */
/**
 * Bidi marks, overrides and isolates. The whitespace/control class above does
 * not reach them, so a framing field could render in an order it is not written
 * in — text that reads as a reassurance on screen and as gibberish in the store
 * or an export. `prompt-origin.ts` strips exactly this set for the other
 * untrusted field of the credential dialog; the two agree deliberately.
 *
 * This does cost something in right-to-left text: LRM/RLM (U+200E/200F) are
 * legitimate there for ordering neutral characters like digits and punctuation.
 * It is taken anyway, for the same reason `prompt-origin.ts` takes it — these
 * are short LABELS, not prose, and a label that can lie about its own direction
 * is worse than one that renders a phone number's punctuation the wrong way.
 * Do not copy this into a sanitiser for message BODIES.
 */
const BIDI_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function sanitizeFramingField(s: string, max = 200): string {
	const flat = s.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').replace(BIDI_CHARS, '').trim();
	// Cut by code point so a truncation cannot end on a lone surrogate.
	const points = [...flat];
	return points.length > max ? `${points.slice(0, max - 1).join('')}…` : flat;
}
