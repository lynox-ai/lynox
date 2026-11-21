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
 *  - every other attribute whose value names an address (`//`, or a scheme such as `http:` at
 *    its start): `ping` on a link posts to its list on a click, and the next such attribute
 *    should not need its own line here;
 *  - every piece of CSS (a `style` element, a `style` attribute, a presentation attribute) that
 *    could name an address. CSS can reach an address only through a function or rule whose name
 *    is spelled out (`url`, `image-set`, `src`, `@import`) or through an escape (`\75 rl(` is
 *    `url(`), so the test is on those spellings, not on a parse: CSS with a backslash, or with
 *    any of those names other than a `url(#id)`, is dropped whole. A `style` element with any
 *    element inside it is dropped as well: the browser joins the text around a child into one
 *    sheet (`@im<g/>port`), so the text the test sees is not the text it reads;
 *  - every animation element that could set one of the above (an `href`, a `ping`, an event
 *    attribute, or a value naming an address).
 * Processing instructions (`<?xml-stylesheet?>`) and the doctype stay behind because only the
 * root element is written out.
 *
 * Text that is not a well-formed svg document (the app shows it inside html, where `<svg>` needs
 * no namespace and a stray tag is forgiven) is read the way the app reads it, by the html parser,
 * and the svg it holds is cleaned and written out well-formed. The result is parsed back as an
 * svg document before it is handed out: a browser renders a broken file up to its first error,
 * so nothing that does not parse back is handed out. Returns null when there is no svg to write.
 */
export function svgExportDocument(svg: string): string | null {
	// Well-formed but outside the SVG namespace (`<svg>` written for html) is not an svg document
	// either; it goes the html way too.
	const xml = parseSvg(svg)?.documentElement;
	const root = xml?.namespaceURI === SVG_NS ? xml : svgInHtml(svg);
	if (!root || root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null;
	cleanAttributes(root);
	cleanChildren(root);
	const out = new XMLSerializer().serializeToString(root);
	const back = parseSvg(out)?.documentElement;
	if (!back || back.namespaceURI !== SVG_NS || back.localName !== 'svg') return null;
	return out;
}

function parseSvg(text: string): Document | null {
	const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
	if (!doc.documentElement || doc.getElementsByTagNameNS('*', 'parsererror').length > 0) return null;
	return doc;
}

/** The first svg element the html parser makes of `text`, as the app's frame would show it. */
function svgInHtml(text: string): Element | null {
	return new DOMParser().parseFromString(text, 'text/html').getElementsByTagNameNS(SVG_NS, 'svg')[0] ?? null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

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

function cleanChildren(el: Element): void {
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
		if (name === 'style' && (child.children.length > 0 || cssCanReachOut(child.textContent ?? ''))) {
			child.remove();
			continue;
		}
		if (ANIMATION_ELEMENTS.has(name) && animationCanReachOut(child)) {
			child.remove();
			continue;
		}
		cleanAttributes(child);
		cleanChildren(child);
	}
}

function animationCanReachOut(el: Element): boolean {
	const target = (el.getAttribute('attributeName') ?? '').toLowerCase().replace(/^[^:]*:/, '');
	if (target === 'href' || target === 'ping' || target === 'base' || target.startsWith('on')) return true;
	return ANIMATION_VALUES.some((a) => {
		const value = el.getAttribute(a);
		return value !== null && (cssCanReachOut(value) || namesAddress(value));
	});
}

function cleanAttributes(el: Element): void {
	const elementName = el.localName.toLowerCase();
	for (const attr of Array.from(el.attributes)) {
		const name = attr.localName.toLowerCase();
		const value = attr.value;
		let drop = false;
		if (attr.namespaceURI === XMLNS_NS) continue;
		if (name.startsWith('on') || name === 'base' || name === 'ping') drop = true;
		else if (name === 'href') drop = !hrefStaysInside(value, elementName);
		else if (NAME_ATTRIBUTES.has(name)) drop = false;
		else if (cssCanReachOut(value)) drop = true;
		// A style attribute is CSS, where `fill:red` is not a scheme; every other value is read as
		// an address could be.
		else if (name !== 'style' && namesAddress(value)) drop = true;
		if (drop) el.removeAttributeNode(attr);
	}
}

/** A value that is or starts like an absolute address: `//host`, or a scheme (`http:host` is read as `http://host`). */
function namesAddress(value: string): boolean {
	return value.includes('//') || /^\s*[a-z][a-z0-9+.-]*:/i.test(value);
}

function hrefStaysInside(value: string, elementName: string): boolean {
	const v = value.trim();
	if (v.startsWith('#')) return true;
	return DATA_IMAGE_ELEMENTS.has(elementName) && /^data:image\//i.test(v);
}
