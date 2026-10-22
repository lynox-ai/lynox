// Text a person reads before something acts on it, with every hidden character shown.

import { hiddenCharIndexes } from './hidden-chars.js';

/** Text the reader acts on, with every hidden character (`hidden-chars.ts`, the same file the
 *  engine refuses a judge rule by) shown as its code point, `⟨U+XXXX⟩`. Not removed: what acts
 *  on the text reads it as it is, so what the reader sees must be that text too: a removed
 *  character would be one the reader never saw and the model or the recipient still gets.
 *  `inPlace: false` for a value that is not running text, such as an address. */
export function visibleText(text: string, opts: { inPlace?: boolean } = {}): string {
	const hidden = new Set(hiddenCharIndexes(text, opts));
	if (hidden.size === 0) return text;
	return Array.from(text, (c, i) => (hidden.has(i) ? `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩` : c)).join('');
}
