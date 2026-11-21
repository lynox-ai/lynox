/**
 * The file an svg artifact is exported as from the gallery.
 *
 * In the app an svg artifact runs in the sandboxed frame under the artifact policy, which keeps
 * every remote load out. A copy opened from disk has none of that around it, and an svg document
 * cannot carry the policy itself: measured with a file opened from disk, Firefox honours no
 * policy element in an svg document at all (neither an XHTML `meta` at the root nor one inside
 * `foreignObject`), and Chromium only the one inside `foreignObject`. So the export keeps the
 * file an svg and takes out everything in it that could reach another address instead.
 *
 * What is taken out, and why each is needed:
 *  - every element outside the SVG namespace, with its content. An XHTML `img` or `iframe` the
 *    parser creates starts loading whether or not it is ever rendered, and `foreignObject` exists
 *    to hold such elements;
 *  - `script`, every `on…` attribute, and `xml:base` (it moves the base an in-document reference
 *    resolves against);
 *  - every `href` (in any namespace) that is not a fragment (`#id`); `image` and `feImage` may
 *    also keep a `data:` address, which a browser loads as an image without any further fetch;
 *  - every piece of CSS (a `style` element, a `style` attribute, a presentation attribute) that
 *    could name an address. CSS can reach an address only through a function or rule whose name
 *    is spelled out (`url`, `image-set`, `src`, `@import`) or through an escape (`\75 rl(` is
 *    `url(`), so the test is on those spellings, not on a parse: CSS with a backslash, or with
 *    any of those names other than a `url(#id)`, is dropped whole;
 *  - every animation element that could set one of the above (an `href`, an event attribute, or
 *    a value naming an address).
 * Processing instructions (`<?xml-stylesheet?>`) and the doctype stay behind because only the
 * root element is written out.
 *
 * Returns null when the text is not a well-formed svg document. A browser renders such a file
 * up to the first error, and what comes before it can still load, so the caller does not hand
 * the text out unchanged.
 */
export function svgExportDocument(svg: string): string | null {
	let doc = parseSvg(svg);
	// In the app an svg artifact is shown inside html, where `<svg>` needs no namespace, and a
	// model often leaves it out. Without it the file is not an svg document, so it is put in. Where
	// it lands does not matter for what is taken out: that runs on whatever the second parse gives.
	if (doc?.documentElement.namespaceURI === null && doc.documentElement.localName === 'svg') {
		doc = parseSvg(svg.replace(/<svg(?=[\s/>])/, `<svg xmlns="${SVG_NS}"`));
	}
	const root = doc?.documentElement;
	if (!root || root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null;
	cleanElement(root);
	return new XMLSerializer().serializeToString(root);
}

function parseSvg(text: string): Document | null {
	const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
	if (!doc.documentElement || doc.getElementsByTagNameNS('*', 'parsererror').length > 0) return null;
	return doc;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Elements that carry an image by address, where a `data:` address is an image and loads nothing more. */
const DATA_IMAGE_ELEMENTS = new Set(['image', 'feimage']);

const PROCESSING_INSTRUCTION = 7;

/** Names, not CSS: a word like `src` in an id or class loads nothing, and dropping an id breaks the references to it. */
const NAME_ATTRIBUTES = new Set(['id', 'class']);

const ANIMATION_ELEMENTS = new Set(['set', 'animate', 'animatetransform', 'animatemotion', 'animatecolor']);

/** The attributes of an animation element that hold the value it sets. */
const ANIMATION_VALUES = ['from', 'to', 'by', 'values'];

/**
 * CSS that can name an address: an escape, or a `url`, `image-set`, `src` or `@import` spelled
 * out. A `url(` followed by `#` (a reference into the document, e.g. a gradient) is allowed and
 * is taken out before the test.
 */
function cssCanReachOut(css: string): boolean {
	if (css.includes('\\')) return true;
	// The whole reference goes, name included: a fragment named `src-grad` is still a fragment.
	const withoutFragments = css.replace(/url\(\s*(['"]?)#[^)'"]*\1\s*\)/gi, '');
	return /url|image-set|src|@import/i.test(withoutFragments);
}

function cleanElement(el: Element): void {
	// A processing instruction inside the root is not honoured as a stylesheet link, but it says
	// nothing an exported picture needs either.
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === PROCESSING_INSTRUCTION) node.remove();
	}
	for (const child of Array.from(el.children)) {
		const name = child.localName.toLowerCase();
		if (child.namespaceURI !== SVG_NS || name === 'script' || name === 'foreignobject') {
			child.remove();
			continue;
		}
		if (name === 'style' && cssCanReachOut(child.textContent ?? '')) {
			child.remove();
			continue;
		}
		if (ANIMATION_ELEMENTS.has(name) && animationCanReachOut(child)) {
			child.remove();
			continue;
		}
		cleanAttributes(child);
		cleanElement(child);
	}
	if (el.parentNode === el.ownerDocument) cleanAttributes(el);
}

function animationCanReachOut(el: Element): boolean {
	const target = (el.getAttribute('attributeName') ?? '').toLowerCase().replace(/^[^:]*:/, '');
	if (target === 'href' || target === 'base' || target.startsWith('on')) return true;
	return ANIMATION_VALUES.some((a) => {
		const value = el.getAttribute(a);
		return value !== null && (cssCanReachOut(value) || value.includes('//') || /^\s*[a-z][a-z0-9+.-]*:/i.test(value));
	});
}

function cleanAttributes(el: Element): void {
	const elementName = el.localName.toLowerCase();
	for (const attr of Array.from(el.attributes)) {
		const name = attr.localName.toLowerCase();
		const value = attr.value;
		let drop = false;
		if (name.startsWith('on') || name === 'base') drop = true;
		else if (name === 'href') drop = !hrefStaysInside(value, elementName);
		else if (!NAME_ATTRIBUTES.has(name) && cssCanReachOut(value)) drop = true;
		if (drop) el.removeAttributeNode(attr);
	}
}

function hrefStaysInside(value: string, elementName: string): boolean {
	const v = value.trim();
	if (v.startsWith('#')) return true;
	return DATA_IMAGE_ELEMENTS.has(elementName) && /^data:image\//i.test(v);
}
