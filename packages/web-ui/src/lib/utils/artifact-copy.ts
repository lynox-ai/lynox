/**
 * The text an artifact's "Copy text" button copies.
 *
 * A markdown or data artifact copies what lynox wrote. An HTML artifact copies the text a reader
 * sees in it: no tags, scripts or styles. An HTML artifact that shows no text (a chart drawn only
 * with graphics or a script) has nothing to copy, and then it gets no button at all.
 */

/** Elements whose content is never shown as text. */
const HIDDEN = 'script, style, noscript, template, head';

/** Elements that start a new line in the copied text. */
const BLOCK = 'p, div, section, article, header, footer, main, aside, nav, li, ul, ol, table, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, figure, figcaption, dl, dt, dd, br, hr';

/** The visible text of an HTML document or fragment, or '' when it shows none. */
export function visibleTextOfHtml(html: string): string {
	if (typeof DOMParser === 'undefined') return '';
	const doc = new DOMParser().parseFromString(html, 'text/html');
	doc.querySelectorAll(HIDDEN).forEach((el) => el.remove());
	const body = doc.body;
	if (!body) return '';
	// Cells of one row stay on one line, separated by a tab, as a spreadsheet pastes them.
	body.querySelectorAll('td, th').forEach((cell) => {
		if (cell.nextElementSibling) cell.append(doc.createTextNode('\t'));
	});
	body.querySelectorAll(BLOCK).forEach((el) => {
		el.before(doc.createTextNode('\n'));
		el.after(doc.createTextNode('\n'));
	});
	return (body.textContent ?? '')
		.split('\n')
		.map((line) => line.replace(/[ \u00a0]+/g, ' ').trim())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
