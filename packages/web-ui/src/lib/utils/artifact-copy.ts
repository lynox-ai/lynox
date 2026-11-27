/**
 * The text an artifact's copy button takes.
 *
 * A markdown card copies the text it shows: its rendered body, which carries no `style` or `class`
 * (see `MarkdownRenderer.svelte`), without the elements it does not show. What the card cannot
 * hide, the copy cannot carry either. A data card copies its file, and says so when the preview
 * shows less. Before either reaches the clipboard, the characters a reader does not see are taken
 * out. An HTML card gets no copy button: what its frame shows cannot be read from its source.
 */
import { withoutHidden } from '../stores/contained-way-out.js';

/** Elements whose content is never shown as text, or that the card does not show. */
const NOT_SHOWN = 'script, style, noscript, template, head, title, [hidden], [aria-hidden="true"]';

/** Elements that start a new block in the copied text. */
const BLOCK = 'p, div, section, article, header, footer, main, aside, nav, ul, ol, table, h1, h2, h3, h4, h5, h6, pre, blockquote, figure, figcaption, dl, hr, details';

/** Elements that end a line in the copied text. */
const LINE = 'li, tr, dt, dd, br, summary';

/** The text an HTML fragment shows, or '' when it shows none. */
export function shownTextOfHtml(html: string): string {
	if (typeof DOMParser === 'undefined') return '';
	const doc = new DOMParser().parseFromString(html, 'text/html');
	const body = doc.body;
	if (!body) return '';
	body.querySelectorAll(NOT_SHOWN).forEach((el) => el.remove());
	// A closed <details> shows its summary only.
	body.querySelectorAll('details:not([open])').forEach((d) => {
		Array.from(d.children).forEach((child) => { if (child.tagName !== 'SUMMARY') child.remove(); });
		Array.from(d.childNodes).forEach((node) => { if (node.nodeType === 3) node.remove(); });
	});
	// Cells of one row stay on one line, separated by a tab, as a spreadsheet pastes them.
	body.querySelectorAll('td, th').forEach((cell) => {
		if (cell.nextElementSibling) cell.append(doc.createTextNode('\t'));
	});
	body.querySelectorAll(LINE).forEach((el) => { el.after(doc.createTextNode('\n')); });
	body.querySelectorAll(BLOCK).forEach((el) => {
		el.before(doc.createTextNode('\n\n'));
		el.after(doc.createTextNode('\n\n'));
	});
	return (body.textContent ?? '')
		.split('\n')
		.map((line) => line.replace(/[ \u00a0]+/g, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/** The copied text without the characters a reader does not see, and whether any were there. */
export function copyableText(text: string): { text: string; removed: boolean } {
	return withoutHidden(text);
}
