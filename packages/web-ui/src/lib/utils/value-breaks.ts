/**
 * Where a host or a URL may break across lines (U-391): never inside a name, at a hyphen or
 * mid-word. A value that fits on one line moves to the next line whole; only a longer one breaks,
 * a host after a dot, a URL after a dot or a slash (never inside the `//` of its scheme). The page
 * keeps each piece unbreakable, with a `<wbr>` between them (`WholeValue`).
 */
export type ValueKind = 'host' | 'url';

/** The value in pieces that each end where a break may fall: `acme-store.` / `myshopify.` / `com`. */
export function valueSegments(value: string, kind: ValueKind): string[] {
	return value.split(kind === 'host' ? /(?<=\.)/ : /(?<=[./])(?!\/)/);
}

/** A sentence split at a placeholder, with its other placeholders filled: the value goes between the parts. */
export function placeholderParts(sentence: string, placeholder: string): { before: string; after: string } {
	const i = sentence.indexOf(placeholder);
	return i < 0 ? { before: sentence, after: '' } : { before: sentence.slice(0, i), after: sentence.slice(i + placeholder.length) };
}
