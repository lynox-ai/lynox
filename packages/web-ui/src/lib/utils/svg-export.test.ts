// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { svgExportDocument } from './svg-export.js';

// jsdom parses the svg here; what a browser does with the exported file opened from disk is not
// measurable in this environment. Each form below was also loaded from disk in Chromium and
// Firefox, raw and after the export: after it, none loads anything. Raw, most load their address
// in at least one of the two; some load nothing there either (a use to another file, an animated
// fill, an xml:base, an instruction inside the root, an animated ping, a data- attribute, an
// svg with no namespace, which is no svg document as a file), and are kept as forms the export
// has to hold against all the same.

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const HOST = 'elsewhere.example';
const AT = `https://${HOST}/x`;
/** An svg document as a data address whose style imports {@link AT}, every telling character encoded. */
const DATA_DOC = `data:image/svg+xml,%3Csvg%20xmlns=%22http:%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cstyle%3E%40import%20%22https:%2F%2F${HOST}%2Fx%22%3B%3C%2Fstyle%3E%3Cmask%20id=%22m%22%2F%3E%3C%2Fsvg%3E#m`;

/** Each form an svg can reach another address with, by the name a failing test reports. */
const REACHING_OUT: Record<string, string> = {
	'an image href': `<svg ${NS}><image href="${AT}" width="9" height="9"/></svg>`,
	'an image xlink:href': `<svg ${NS}><image xlink:href="${AT}" width="9" height="9"/></svg>`,
	'an image href without slashes (http:host)': `<svg ${NS}><image href="http:${HOST}/x" width="9" height="9"/></svg>`,
	'a feImage href': `<svg ${NS}><filter id="f"><feImage href="${AT}"/></filter></svg>`,
	'a use href to another file': `<svg ${NS}><use href="${AT}#a"/></svg>`,
	'a url() in a presentation attribute': `<svg ${NS}><rect width="9" height="9" fill="url(${AT}#a)"/></svg>`,
	'a url() in a marker attribute': `<svg ${NS}><line x2="9" y2="9" marker-end="url(${AT}#m)"/></svg>`,
	'a url() in a style attribute': `<svg ${NS}><rect width="9" height="9" style="cursor:url(${AT}),auto"/></svg>`,
	'a url() in a style element': `<svg ${NS}><style>rect{fill:url(${AT}#a)}</style><rect width="9" height="9"/></svg>`,
	'an @import in a style element': `<svg ${NS}><style>@import "${AT}";</style></svg>`,
	'an @import in a CDATA section': `<svg ${NS}><style><![CDATA[@import "${AT}";]]></style></svg>`,
	'an escaped url( in a style element': `<svg ${NS}><style>rect{fill:\\75 rl(${AT}#a)}</style></svg>`,
	'a font-face src': `<svg ${NS}><style>@font-face{font-family:x;src:url(${AT})}</style></svg>`,
	'an image-set': `<svg ${NS}><style>svg{background-image:image-set("${AT}" 1x)}</style></svg>`,
	'a prefixed image-set': `<svg ${NS}><style>svg{background-image:-webkit-image-set("${AT}" 1x)}</style></svg>`,
	'an image() with an address': `<svg ${NS}><style>svg{background-image:image("${AT}")}</style></svg>`,
	'a url( with spaces inside': `<svg ${NS}><style>svg{background-image:url( "${AT}" )}</style></svg>`,
	'an XHTML img inside foreignObject': `<svg ${NS}><foreignObject width="9" height="9"><img xmlns="http://www.w3.org/1999/xhtml" src="${AT}"/></foreignObject></svg>`,
	'an XHTML img outside foreignObject': `<svg ${NS}><img xmlns="http://www.w3.org/1999/xhtml" src="${AT}"/></svg>`,
	'a script': `<svg ${NS}><script>fetch("${AT}")</script></svg>`,
	'a prefixed script': `<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:script>fetch("${AT}")</s:script></s:svg>`,
	'an event attribute on the root': `<svg ${NS} onload="fetch('${AT}')"></svg>`,
	'an event attribute on a child': `<svg ${NS}><rect width="9" height="9" onmouseover="fetch('${AT}')"/></svg>`,
	'an animation that sets an href': `<svg ${NS}><image width="9" height="9" href="#x"><set attributeName="href" to="${AT}"/></image></svg>`,
	'an animation that sets a url()': `<svg ${NS}><rect width="9" height="9"><animate attributeName="fill" values="red;url(${AT}#a)"/></rect></svg>`,
	'an xml:base': `<svg ${NS}><g xml:base="${AT}/"><use href="#a"/></g></svg>`,
	'an xml-stylesheet instruction before the root': `<?xml-stylesheet href="${AT}" type="text/css"?><svg ${NS}/>`,
	'an xml-stylesheet instruction inside the root': `<svg ${NS}><?xml-stylesheet href="${AT}" type="text/css"?></svg>`,
	'an anchor to another address': `<svg ${NS}><a href="${AT}"><text>t</text></a></svg>`,
	'a ping on an anchor': `<svg ${NS}><a href="#r" ping="${AT}"><rect id="r" width="9" height="9"/></a></svg>`,
	'an animation that sets a ping': `<svg ${NS}><a href="#r"><set attributeName="ping" to="${AT}"/><rect id="r" width="9" height="9"/></a></svg>`,
	'an address in an attribute with no address meaning': `<svg ${NS}><rect width="9" height="9" data-x="${AT}"/></svg>`,
	'an @import split by an element inside the style element': `<svg ${NS}><style>@im<g>x</g>port "${AT}";</style></svg>`,
	'a url( split by a desc inside the style element': `<svg ${NS}><style>rect{cursor:u<desc>x</desc>rl(${AT}),auto}</style></svg>`,
	'an @import split by a script inside the style element': `<svg ${NS}><style>@im<script>x</script>port "${AT}";</style></svg>`,
	'an image in an svg that is not well-formed': `<svg ${NS}><image href="${AT}"/><g></svg>`,
	'an @import split by an element in an svg with no namespace': `<svg><style>@im<g>x</g>port "${AT}";</style></svg>`,
	// Fully percent-encoded, so no literal `//`, `@` or quote gives the address away: only the rule
	// that a url(data:) is not spared takes these out.
	'an @import in an svg document named by url(data:) as a mask': `<svg ${NS}><rect width="9" height="9" mask="url(${DATA_DOC})"/></svg>`,
	'an @import in an svg document named by url(data:) in a style attribute': `<svg ${NS}><rect width="9" height="9" style="mask:url(${DATA_DOC})"/></svg>`,
	'an @import in an svg document named by url(data:) in a style element': `<svg ${NS}><style>rect{fill:url(${DATA_DOC})}</style><rect width="9" height="9"/></svg>`,
	'an @import in an svg document named by url(data:) set by an animation': `<svg ${NS}><rect width="9" height="9"><set attributeName="mask" to="url(${DATA_DOC})"/></rect></svg>`,
	'a script behind a prefix the html parser keeps in its name': `<svg><g xmlns:xlink="http://www.w3.org/2000/svg"><xlink:script>fetch("${AT}")</xlink:script></g></svg>`,
	'a style behind a prefix the html parser keeps in its name': `<svg><g xmlns:xlink="http://www.w3.org/2000/svg"><xlink:style>@import "${AT}";</xlink:style></g></svg>`,
	'an XHTML img behind a prefix the html parser keeps in its name': `<svg><g xmlns:xlink="http://www.w3.org/1999/xhtml"><xlink:img src="${AT}"/></g></svg>`,
	'an address split by a tab in an animated value': `<svg ${NS}><image width="9" height="9" href="#x"><set attributeName="fill" to="h&#9;ttp:${HOST}/x"/></image></svg>`,
	'an address split by a tab in an attribute': `<svg ${NS}><rect width="9" height="9" data-x="h&#9;ttp:${HOST}/x"/></svg>`,
};

describe('svgExportDocument', () => {
	for (const [form, svg] of Object.entries(REACHING_OUT)) {
		it(`leaves out ${form}`, () => {
			// Control: the form names the address before the export.
			expect(svg).toContain(HOST);
			const out = svgExportDocument(svg);
			expect(out, `${form} was refused instead of cleaned`).not.toBeNull();
			expect(out).not.toContain(HOST);
		});
	}

	// Each rule on its own: the forms above all carry an address, which the address rule takes out
	// as well, so a rule could go missing behind it. These carry none.
	describe('takes out, with no address to give it away,', () => {
		const clean = (svg: string): Document => new DOMParser().parseFromString(svgExportDocument(svg)!, 'image/svg+xml');

		it('an element outside the SVG namespace', () => {
			const doc = clean(`<svg ${NS}><p xmlns="http://www.w3.org/1999/xhtml">x</p><rect width="9" height="9"/></svg>`);
			expect(doc.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'p')).toHaveLength(0);
			expect(doc.querySelector('rect')).not.toBeNull();
		});

		it('a foreignObject, even one holding only svg', () => {
			const doc = clean(`<svg ${NS}><foreignObject width="9" height="9"><rect width="9" height="9"/></foreignObject></svg>`);
			expect(doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'foreignObject')).toHaveLength(0);
		});

		it('an animation that sets an href', () => {
			const doc = clean(`<svg ${NS}><image width="9" height="9" href="#x"><set attributeName="href" to="y.png"/></image></svg>`);
			expect(doc.querySelector('set')).toBeNull();
		});

		it('an animation that sets a ping', () => {
			const doc = clean(`<svg ${NS}><a href="#r"><set attributeName="ping" to="y"/><rect id="r" width="9" height="9"/></a></svg>`);
			expect(doc.querySelector('set')).toBeNull();
		});

		it('an animation whose value is css that reaches out', () => {
			const doc = clean(`<svg ${NS}><rect width="9" height="9"><animate attributeName="fill" values="red;url(y.svg#a)"/></rect></svg>`);
			expect(doc.querySelector('animate')).toBeNull();
		});

		it('an event attribute', () => {
			const doc = clean(`<svg ${NS}><rect width="9" height="9" onclick="alert(1)"/></svg>`);
			expect(doc.querySelector('rect')?.hasAttribute('onclick')).toBe(false);
		});

		it('an xml:base', () => {
			const doc = clean(`<svg ${NS}><g xml:base="sub/"><rect width="9" height="9"/></g></svg>`);
			expect(doc.querySelector('g')?.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'base')).toBeNull();
		});

		it('a ping', () => {
			const doc = clean(`<svg ${NS}><a href="#r" ping="y"><rect id="r" width="9" height="9"/></a></svg>`);
			expect(doc.querySelector('a')?.hasAttribute('ping')).toBe(false);
		});
	});

	it('refuses a file that holds, once written, what the cleaning takes out', () => {
		// No input is known that makes a browser's writer and reader disagree; this stands in for
		// one, so the check that catches it is exercised: the first write slips in a script.
		const write = XMLSerializer.prototype.serializeToString;
		let calls = 0;
		const spy = vi.spyOn(XMLSerializer.prototype, 'serializeToString').mockImplementation(function (this: XMLSerializer, node: Node) {
			const out = write.call(this, node);
			return ++calls === 1 ? out.replace(/<\/svg>$/, '<script>x</script></svg>') : out;
		});
		try {
			expect(svgExportDocument(`<svg ${NS}><rect width="9" height="9"/></svg>`)).toBeNull();
			expect(calls).toBe(2);
		} finally {
			spy.mockRestore();
		}
		// Control: the same input, written as it is, goes out.
		expect(svgExportDocument(`<svg ${NS}><rect width="9" height="9"/></svg>`)).not.toBeNull();
	});

	it('keeps a drawing whole: shapes, text, a gradient by url(#id) in an attribute and in css, an in-document use', () => {
		const svg = `<svg ${NS} viewBox="0 0 10 10"><defs><linearGradient id="src-grad"><stop offset="0" stop-color="red"/></linearGradient>`
			+ `<circle id="dot" r="1"/></defs><style>.c{fill:url(#src-grad)}</style>`
			+ `<rect class="c" width="5" height="5" fill="url(#src-grad)" style="stroke:url('#src-grad');stroke-width:2"/>`
			+ `<use href="#dot" x="3"/><use xlink:href="#dot" x="6"/><text x="1" y="9">Umsatz 2026</text></svg>`;
		const out = svgExportDocument(svg)!;
		const doc = new DOMParser().parseFromString(out, 'image/svg+xml');
		expect(doc.querySelector('linearGradient')?.getAttribute('id')).toBe('src-grad');
		expect(doc.querySelector('style')?.textContent).toBe('.c{fill:url(#src-grad)}');
		const rect = doc.querySelector('rect')!;
		expect(rect.getAttribute('fill')).toBe('url(#src-grad)');
		expect(rect.getAttribute('style')).toBe("stroke:url('#src-grad');stroke-width:2");
		expect(rect.getAttribute('class')).toBe('c');
		const uses = doc.querySelectorAll('use');
		expect(uses[0]!.getAttribute('href')).toBe('#dot');
		expect(uses[1]!.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBe('#dot');
		expect(doc.querySelector('text')?.textContent).toBe('Umsatz 2026');
		expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 10 10');
	});

	it('keeps style rules whose names only contain a css function word', () => {
		const css = '.urlaub{fill:red}.src-box{fill:blue}';
		const out = svgExportDocument(`<svg ${NS}><style>${css}</style><rect class="urlaub" width="9" height="9"/></svg>`)!;
		expect(new DOMParser().parseFromString(out, 'image/svg+xml').querySelector('style')?.textContent).toBe(css);
	});

	it('takes out an embedded font, as a data address is not spared', () => {
		const out = svgExportDocument(`<svg ${NS}><style>@font-face{font-family:f;src:url(data:font/woff2;base64,d09GMg==)}</style><rect width="9" height="9"/></svg>`)!;
		expect(out).not.toContain('d09GMg');
		expect(new DOMParser().parseFromString(out, 'image/svg+xml').querySelector('rect')).not.toBeNull();
	});

	it('keeps labels and roles that mention an address or a css word', () => {
		const out = svgExportDocument(`<svg ${NS} role="img" aria-labelledby="src-title" aria-label="see ${AT}"><title id="src-title">Urlaub 2026</title></svg>`)!;
		const root = new DOMParser().parseFromString(out, 'image/svg+xml').documentElement;
		expect(root.getAttribute('role')).toBe('img');
		expect(root.getAttribute('aria-labelledby')).toBe('src-title');
		expect(root.getAttribute('aria-label')).toBe(`see ${AT}`);
	});

	it('leaves the text of a foreignObject behind as svg text at its place', () => {
		const out = svgExportDocument(`<svg ${NS}><foreignObject x="10" y="20" width="90" height="30"><div xmlns="http://www.w3.org/1999/xhtml">Label <b>A</b><script>x()</script></div></foreignObject></svg>`)!;
		const doc = new DOMParser().parseFromString(out, 'image/svg+xml');
		const text = doc.querySelector('text')!;
		expect(text.textContent).toBe('Label A');
		expect(text.getAttribute('x')).toBe('10');
		expect(text.getAttribute('y')).toBe('20');
		expect(doc.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', '*')).toHaveLength(0);
	});

	it('exports a drawing written for html with an undeclared editor prefix', () => {
		const out = svgExportDocument('<svg viewBox="0 0 9 9"><g inkscape:label="L"><circle r="2"/></g><sodipodi:namedview/></svg>');
		expect(out).not.toBeNull();
		const doc = new DOMParser().parseFromString(out!, 'image/svg+xml');
		expect(doc.querySelector('circle')?.getAttribute('r')).toBe('2');
		expect(out).not.toContain('inkscape');
		expect(out).not.toContain('namedview');
	});

	it('keeps a label with a word before a colon', () => {
		const out = svgExportDocument(`<svg ${NS}><g aria-label="Umsatz: 2026" font-family="Times: x"><rect width="9" height="9"/></g></svg>`)!;
		const g = new DOMParser().parseFromString(out, 'image/svg+xml').querySelector('g')!;
		expect(g.getAttribute('aria-label')).toBe('Umsatz: 2026');
		expect(g.getAttribute('font-family')).toBe('Times: x');
	});

	it('keeps a data: image in an image but not a data: address in a use', () => {
		const data = 'data:image/png;base64,iVBORw0KGgo=';
		const out = svgExportDocument(`<svg ${NS}><image href="${data}" width="9" height="9"/><use href="data:image/svg+xml,x#a"/></svg>`)!;
		const doc = new DOMParser().parseFromString(out, 'image/svg+xml');
		expect(doc.querySelector('image')?.getAttribute('href')).toBe(data);
		expect(doc.querySelector('use')?.hasAttribute('href')).toBe(false);
	});

	it('puts in the namespace an svg written for html leaves out, and still leaves out its remote image', () => {
		const out = svgExportDocument(`<svg viewBox="0 0 9 9"><circle r="2"/><image href="${AT}"/></svg>`);
		expect(out).not.toBeNull();
		const doc = new DOMParser().parseFromString(out!, 'image/svg+xml');
		expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
		expect(doc.querySelector('circle')?.getAttribute('r')).toBe('2');
		expect(out).not.toContain(HOST);
	});

	it('refuses text with no svg in it', () => {
		expect(svgExportDocument(`<html><body><img src="${AT}"></body></html>`)).toBeNull();
		expect(svgExportDocument('')).toBeNull();
	});

	it('writes an svg that is not well-formed out well-formed, read as the app shows it', () => {
		const out = svgExportDocument('<svg viewBox="0 0 9 9"><circle r="2"><rect width="1" height="1"></svg>');
		expect(out).not.toBeNull();
		const doc = new DOMParser().parseFromString(out!, 'image/svg+xml');
		expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
		expect(doc.documentElement.namespaceURI).toBe('http://www.w3.org/2000/svg');
		expect(doc.querySelector('circle')?.getAttribute('r')).toBe('2');
		expect(doc.querySelector('rect')?.getAttribute('width')).toBe('1');
	});
});
