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
 * Characters that forge a label rather than fill it: the bidi OVERRIDES and
 * ISOLATES, which render text in an order it is not written in, and the
 * zero-width formatters, which put content in a field that looks empty.
 *
 * LRM/RLM (U+200E/200F) are deliberately NOT here, and the omission is the
 * considered half. They are legitimate in right-to-left text — an Arabic or
 * Hebrew contact name orders its digits and punctuation with them — and this
 * function is shared by six seed-message surfaces where the value is a real
 * person's name. Stripping them there reorders `אבי ‎+41 79 123`. The overrides
 * buy an attacker the actual reversal; the marks only nudge neutrals, so the
 * trade goes the other way. `prompt-origin.ts` does strip the marks as well,
 * because its field is a workflow label that is never a name — that difference
 * is intended, not drift.
 */
const FORGING_CHARS = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/g;

export function sanitizeFramingField(s: string, max = 200): string {
	// Strip BEFORE collapsing: removing a character between two spaces after the
	// collapse leaves the two spaces behind, so `'a \u200E b'` would keep a double
	// space and `'\u202E x'` a leading one.
	const flat = s.replace(FORGING_CHARS, '').replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
	// Cut by code point so a truncation cannot end on a lone surrogate.
	const points = [...flat];
	return points.length > max ? `${points.slice(0, max - 1).join('')}…` : flat;
}
