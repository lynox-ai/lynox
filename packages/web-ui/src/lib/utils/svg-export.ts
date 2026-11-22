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
 *    to hold such elements. A `foreignObject` leaves its text behind as an svg `text` at its place,
 *    so a label written as html does not vanish from the drawing;
 *  - `script`, every `on…` attribute, and `xml:base` (it moves the base an in-document reference
 *    resolves against);
 *  - every `href` (in any namespace) that is not a fragment (`#id`); `image` and `feImage` may
 *    also keep a `data:` address, which a browser loads as an image without any further fetch;
 *  - every other attribute whose value names an address (`//`, or a scheme such as `http:` at
 *    its start): `ping` on a link posts to its list on a click, and the next such attribute
 *    should not need its own line here. Names and labels (`id`, `class`, `role`, `aria-…`) are
 *    left alone: they load nothing, and a label may well mention an address;
 *  - every `style` element and every other attribute value whose CSS could name an address. CSS
 *    reaches an address only through a function or rule spelled out (`url(`, `image-set(`,
 *    `image(`, `cross-fade(`, `element(`, `@import`) or through an escape (`\75 rl(` is `url(`),
 *    so the test is on those spellings, not on a parse: CSS with a backslash, or with any of them
 *    other than a `url(#id)` (a reference into the document) is dropped whole. A `url(data:…)` is
 *    not spared either: as a mask, fill, filter, marker or clip it names a document, not an
 *    image, and Firefox loads what that document imports (measured), so an embedded font goes
 *    with it. A word that only contains one (`.urlaub`,
 *    `.src-box`) is not a function and stays. A `style` element with any
 *    element inside it is dropped as well: the browser joins the text around a child into one
 *    sheet (`@im<g/>port`), so the text the test sees is not the text it reads;
 *  - every animation element that could set one of the above (an `href`, a `ping`, an event
 *    attribute, or a value naming an address).
 * Processing instructions (`<?xml-stylesheet?>`) and the doctype stay behind because only the
 * root element is written out.
 *
 * Text that is not a well-formed svg document (the app shows it inside html, where `<svg>` needs
 * no namespace and a stray tag is forgiven) is read the way the app reads it, by the html parser.
 * Its first svg is the one written (a second one in the same text is left out); an element or
 * attribute whose name carries a prefix (`inkscape:label`, declared or not) is taken out first: the
 * html parser keeps a prefix as part of the name, which would make the written file unreadable. The svg is then written out and read back as an svg document BEFORE anything is taken
 * out. What is cleaned is then the tree the file will hold, not the html parser's tree: the two
 * can differ (as with a prefix the html parser keeps as part of a name, which is a real
 * namespace prefix to the svg parser), and a check on one says nothing about the other.
 *
 * The cleaned file is read back and cleaned once more, and is handed out only if that changes
 * nothing. Whatever reads differently once written, by a route no line above names, makes the
 * export refuse rather than hand out a file that was not the one checked. Returns null then, and
 * when there is no svg to write.
 */
export function svgExportDocument(svg: string): string | null {
	// Well-formed but outside the SVG namespace (`<svg>` written for html) is not an svg document
	// either; it goes the html way too.
	const xml = parseSvg(svg)?.documentElement;
	const html = xml?.namespaceURI === SVG_NS ? null : svgInHtml(svg);
	if (html) dropUnboundPrefixes(html);
	const root = html ? parseSvg(new XMLSerializer().serializeToString(html))?.documentElement : xml;
	const out = root ? cleaned(root) : null;
	if (out === null) return null;
	const back = parseSvg(out)?.documentElement;
	return back && cleaned(back) === out ? out : null;
}

/** `root` cleaned and written out, or null when it is not an svg root. */
function cleaned(root: Element): string | null {
	if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') return null;
	cleanAttributes(root);
	cleanChildren(root);
	return new XMLSerializer().serializeToString(root);
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

/**
 * The html parser keeps a prefix as part of a name (`inkscape:label`, `xlink:script`), which the svg
 * parser then reads as an unbound prefix and refuses. Every such name goes, declared or not (an
 * element like `svg:rect` included); the namespaces the html parser does bind (xlink, xml, xmlns)
 * are not names with a colon in this tree and stay. Taking those out keeps such a
 * drawing exportable; what is cleaned is still only the tree read back as svg.
 */
function dropUnboundPrefixes(el: Element): void {
	for (const attr of Array.from(el.attributes)) {
		if (attr.namespaceURI === null && attr.name.includes(':')) el.removeAttributeNode(attr);
	}
	for (const child of Array.from(el.children)) {
		if (child.localName.includes(':')) child.remove();
		else dropUnboundPrefixes(child);
	}
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** Elements that carry an image by address, where a `data:` address is an image and loads nothing more. */
const DATA_IMAGE_ELEMENTS = new Set(['image', 'feimage']);

const PROCESSING_INSTRUCTION = 7;

/** Names and labels, not CSS or addresses: they load nothing, and dropping an id breaks the references to it. */
const NAME_ATTRIBUTES = new Set(['id', 'class', 'role']);

const ANIMATION_ELEMENTS = new Set(['set', 'animate', 'animatetransform', 'animatemotion', 'animatecolor']);

/** The attributes of an animation element that hold the value it sets. */
const ANIMATION_VALUES = ['from', 'to', 'by', 'values'];

/**
 * CSS that can name an address: an escape, a function that takes one (`url(`, `image-set(` with
 * its prefixed forms, `image(`, `cross-fade(`, `element(`), or an `@import`. A `url(#id)` (a
 * reference into the document, e.g. a gradient) is taken out before the test; a `url(data:…)` is not,
 * as it can name a document that loads more.
 */
function cssCanReachOut(css: string): boolean {
	if (css.includes('\\')) return true;
	// The whole reference goes, name included: a fragment named `src-grad` is still a fragment.
	const withoutInside = css.replace(/url\(\s*(['"]?)#[^)'"]*\1\s*\)/gi, '');
	return /(?:url|image-set|image|cross-fade|element)\s*\(|@import/i.test(withoutInside);
}

function cleanChildren(el: Element): void {
	// A processing instruction inside the root is not honoured as a stylesheet link, but it says
	// nothing an exported picture needs either.
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === PROCESSING_INSTRUCTION) node.remove();
	}
	for (const child of Array.from(el.children)) {
		const name = child.localName.toLowerCase();
		if (name === 'foreignobject' && child.namespaceURI === SVG_NS) {
			const label = textOf(child);
			if (label) child.replaceWith(labelAt(child, label));
			else child.remove();
			continue;
		}
		if (child.namespaceURI !== SVG_NS || name === 'script') {
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

/** The text a foreignObject shows: its text nodes outside any script or style, run together. */
function textOf(el: Element): string {
	const parts: string[] = [];
	const walk = (node: Node): void => {
		for (const n of Array.from(node.childNodes)) {
			if (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE) parts.push(n.nodeValue ?? '');
			else if (n.nodeType === ELEMENT_NODE && !/^(?:script|style)$/i.test((n as Element).localName)) walk(n);
		}
	};
	walk(el);
	return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** An svg `text` holding `label` at the top left of `el`, with no attribute but its position. */
function labelAt(el: Element, label: string): Element {
	const text = el.ownerDocument.createElementNS(SVG_NS, 'text');
	for (const a of ['x', 'y']) {
		const v = el.getAttribute(a);
		if (v !== null && /^-?\d+(?:\.\d+)?$/.test(v.trim())) text.setAttribute(a, v.trim());
	}
	text.setAttribute('dominant-baseline', 'hanging');
	text.textContent = label;
	return text;
}

const TEXT_NODE = 3;
const CDATA_NODE = 4;
const ELEMENT_NODE = 1;

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
		else if (NAME_ATTRIBUTES.has(name) || name.startsWith('aria-')) drop = false;
		else if (cssCanReachOut(value)) drop = true;
		// A style attribute is CSS, where `fill:red` is not a scheme; every other value is read as
		// an address could be.
		else if (name !== 'style' && namesAddress(value)) drop = true;
		if (drop) el.removeAttributeNode(attr);
	}
}

/**
 * A value that is or starts like an address that loads: `//host`, or a scheme that fetches or runs
 * (`http:host` is read as `http://host`). Read as the URL parser reads it: tab, carriage return
 * and line feed anywhere are dropped, a backslash is a slash, and leading spaces and controls go.
 * Only schemes that load count, so a word before a colon (`Umsatz: 2026` in a label) stays.
 */
function namesAddress(value: string): boolean {
	const v = value.replace(/[\t\n\r]/g, '').replace(/\\/g, '/').replace(/^[\u0000-\u0020\s]+/, '');
	return v.includes('//') || /^(?:https?|ftp|wss?|file|javascript|data|blob|vbscript):/i.test(v);
}

function hrefStaysInside(value: string, elementName: string): boolean {
	const v = value.trim();
	if (v.startsWith('#')) return true;
	return DATA_IMAGE_ELEMENTS.has(elementName) && /^data:image\//i.test(v);
}
