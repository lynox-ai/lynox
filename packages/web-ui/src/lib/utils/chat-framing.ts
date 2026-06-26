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
export function sanitizeFramingField(s: string, max = 200): string {
	const flat = s.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
