/**
 * Where a host or a URL may break across lines (U-391). A value that fits on one line moves to the
 * next line whole; a longer one breaks between pieces, a host after a dot, a URL after a dot or a
 * slash (never inside the `//` of its scheme), so not inside a name or at a hyphen. The page keeps
 * each piece whole while it fits on a line, with a `<wbr>` between them (`WholeValue`); only a piece
 * longer than a line (a long id in a path) breaks inside, anywhere.
 */
export type ValueKind = 'host' | 'url' | 'account';

/**
 * The value in pieces that each end where a break may fall: `acme-store.` / `myshopify.` / `com`. An
 * account (a provider's label: a shop, an address) also after `@` and `/`: `buero@` / `kunden-crm.` /
 * `example`. A character printed as its code point (`<U+202E>`) holds none of these, so it stays in
 * one piece.
 */
export function valueSegments(value: string, kind: ValueKind): string[] {
	return value.split(kind === 'host' ? /(?<=\.)/ : kind === 'account' ? /(?<=[.@/])/ : /(?<=[./])(?!\/)/);
}

/** A sentence split at a placeholder, with its other placeholders filled: the value goes between the parts. */
export function placeholderParts(sentence: string, placeholder: string): { before: string; after: string } {
	const i = sentence.indexOf(placeholder);
	return i < 0 ? { before: sentence, after: '' } : { before: sentence.slice(0, i), after: sentence.slice(i + placeholder.length) };
}
