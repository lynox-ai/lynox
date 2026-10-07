// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderSanitizedMarkdown } from './markdown-render.js';
import { OWN_ATTR, resolveOwnAction } from './markdown-actions.js';

// The markdown view's controls count only when they carry OWN_ATTR, and that holds only if the
// sanitizer removes OWN_ATTR from message markup. This runs the app's own sanitizing path with the
// real DOMPurify in a real DOM (outside one, DOMPurify returns its input unchanged).

/** Message markup copying a built control: same classes and data, and the marker. */
const COPY =
	`<div class="artifact-container" ${OWN_ATTR} data-html="PHA+" data-title="T">`
	+ `<div class="artifact-toolbar" ${OWN_ATTR.toUpperCase()} data-action="toggle"><span id="bar">t</span>`
	+ `<button class="artifact-btn" ${OWN_ATTR}="" data-action="expand" id="copy">e</button></div></div>`
	+ `<button class="diagram-btn mermaid-save" ${OWN_ATTR} data-content="Z3JhcGg=" id="save">s</button>`;

const render = (markdown: string): Document => {
	const doc = document.implementation.createHTMLDocument('');
	doc.body.innerHTML = renderSanitizedMarkdown(markdown);
	return doc;
};

describe('the app\'s sanitizing path', () => {
	it('really sanitizes here (positive control)', () => {
		const doc = render('text <img src="x" onerror="alert(1)"><script>alert(1)</script>');
		expect(doc.querySelector('script')).toBeNull();
		expect(doc.querySelector('[onerror]')).toBeNull();
		expect(doc.querySelector('img')).not.toBeNull();
	});

	it('keeps the copied controls\' classes and data, and removes the marker', () => {
		const doc = render(`Here is a card:\n\n${COPY}\n`);
		// The copy came through: this is what message markup can do.
		expect(doc.querySelector('#copy')?.getAttribute('data-action')).toBe('expand');
		expect(doc.querySelector('#save')?.getAttribute('data-content')).toBe('Z3JhcGg=');
		// And what it cannot: the marker is gone in every spelling.
		expect(doc.querySelectorAll(`[${OWN_ATTR}]`)).toHaveLength(0);
		expect(doc.body.innerHTML.toLowerCase()).not.toContain(OWN_ATTR);
	});

	it('so the copies act on nothing', () => {
		const doc = render(`${COPY}\n`);
		for (const sel of ['#copy', '#bar', '#save']) {
			const el = doc.querySelector(sel);
			expect(el, sel).not.toBeNull();
			expect(resolveOwnAction(el!), sel).toBeNull();
		}
	});
});
