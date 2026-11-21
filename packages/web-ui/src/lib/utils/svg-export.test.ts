// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
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
