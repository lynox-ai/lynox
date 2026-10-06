import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';

import { externalizeLinksInDom, wrapTablesInDom } from './external-links.js';

/**
 * ⚠ READ THIS BEFORE CHANGING A PAYLOAD BELOW.
 *
 * These tests do NOT go through a parser to build their input. They feed the
 * OLD HTML serialiser's output in as a literal string, because that is the only
 * way this defect is observable at all.
 *
 * `DOMPurify.sanitize` returns `body.innerHTML`. Until the 2025 serializer
 * change (Chromium 138, Firefox 140, WebKit 26) attribute-mode escaping touched
 * only `&`, `"` and NBSP — `<` and `>` came back RAW. A CURRENT BROWSER escapes
 * them, so a test that renders markdown in one and inspects the result is green
 * because the serialiser is new, not because the code is right. That is the trap
 * this file exists to avoid, and the same one
 * `prompt-markdown.sanitizer.test.ts` documents one directory over.
 *
 * ⚠ This docstring used to add "and `linkedom`" to that sentence, and it was
 * false. Measured: `setAttribute('title', 'a></body>…')` serialises back through
 * linkedom with a RAW `>`. So linkedom reproduces the old engine here, and a
 * payload built through it would show the breakout too. The literals below are
 * kept anyway, for the reason the false claim was standing in for: they pin what
 * the OLD BROWSER emitted instead of resting on a test library agreeing with
 * it.
 *
 * Each breakout case therefore asserts BOTH shapes on the SAME payload:
 *   · the string rewrite this change removed → a real `<img>` appears;
 *   · the DOM pass that replaced it → none does.
 * The first assertion is the instrument's positive control. If a payload stops
 * breaking the old shape, that assertion fails and says so, instead of the new
 * shape passing for nothing.
 */

/** The shape this change removed, kept verbatim so the payload can be proven live. */
function externalizeLinksAsStringRewrite(html: string): string {
	return html.replace(/<a\b[^>]*>/gi, (tag) => {
		if (/\starget\s*=/i.test(tag)) return tag;
		if (!/\shref\s*=\s*["']https?:\/\//i.test(tag)) return tag;
		return `${tag.slice(0, -1).replace(/\/$/, '')} rel="noreferrer noopener" target="_blank">`;
	});
}

/** Likewise for the table wrapper. */
function wrapTablesAsStringRewrite(html: string): string {
	return html.replace(/<table\b[^>]*>/g, '<div class="table-wrap">$&').replace(/<\/table>/g, '</table></div>');
}

/** Run a DOM pass over a serialised string and give the result back serialised. */
function throughDom(html: string, pass: (root: ParentNode) => void): string {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	pass(document.body as unknown as ParentNode);
	return document.body.innerHTML;
}

/**
 * Run the link pass and hand back the anchor it was supposed to touch, as an
 * ELEMENT. The assertions below used to read the serialised string — a correlate
 * of the thing they meant. `not.toContain('target=')` in particular is also
 * satisfied when the anchor has disappeared entirely, which is not "the link
 * navigates in place". This throws if the anchor is gone, so an absence is a
 * failure with a name instead of a pass.
 */
function anchorAfter(html: string): Element {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	externalizeLinksInDom(document.body as unknown as ParentNode);
	const a = document.querySelector('a');
	if (!a) throw new Error('the fixture lost its anchor — the pass removed it');
	return a;
}

/** How many of the attacker's marker elements a string really contains. */
function liveMarkers(html: string): number {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	return document.querySelectorAll('img[src="/nope"]').length;
}

describe('the attacker marker itself', () => {
	// Without this, every `0` below could mean "the probe cannot see an <img>".
	it('⭐ is countable, so a zero elsewhere means absence and not blindness', () => {
		expect(liveMarkers('<img src="/nope">')).toBe(1);
		expect(liveMarkers('<p>nothing here</p>')).toBe(0);
	});
});

describe('externalizeLinksInDom', () => {
	// The old serialiser's output for the markdown
	// `[x](https://example.com "a><img src=/nope onerror=alert(1)>")`.
	const OLD_SERIALISER_OUTPUT =
		'<a href="https://example.com" title="a><img src=/nope onerror=alert(1)>">x</a>';

	it('⭐ does not let a raw `>` in an attribute become markup — the string rewrite did', () => {
		// Positive control for the payload: the shape this replaced breaks on it.
		expect(
			liveMarkers(externalizeLinksAsStringRewrite(OLD_SERIALISER_OUTPUT)),
			'the payload no longer breaks the old string rewrite, so this test proves nothing',
		).toBe(1);
		// And the DOM pass does not.
		expect(liveMarkers(throughDom(OLD_SERIALISER_OUTPUT, externalizeLinksInDom))).toBe(0);
	});

	// ⭐ THE POINT: an off-site link still opens in a new tab instead of replacing the app.
	it('⭐ sends an absolute http(s) link to a new tab, with a safe rel', () => {
		const a = anchorAfter('<a href="https://example.com/x">x</a>');
		expect(a.getAttribute('target')).toBe('_blank');
		expect(a.getAttribute('rel')).toBe('noreferrer noopener');
		expect(a.getAttribute('href')).toBe('https://example.com/x');
		expect(a.textContent).toBe('x');
	});

	it('leaves in-app and non-http links navigating in place', () => {
		for (const href of ['/threads/7', '#section', 'mailto:a@b.test', 'ftp://x.test/f']) {
			const a = anchorAfter(`<a href="${href}">x</a>`);
			expect(a.hasAttribute('target'), `href ${href} was sent to a new tab`).toBe(false);
			expect(a.hasAttribute('rel'), `href ${href} got a rel it did not need`).toBe(false);
			// …and it is still the same link, not a stripped one.
			expect(a.getAttribute('href')).toBe(href);
		}
	});

	it('leaves an anchor that already declares a target alone', () => {
		const a = anchorAfter('<a href="https://example.com" target="_self">x</a>');
		expect(a.getAttribute('target')).toBe('_self');
		expect(a.hasAttribute('rel')).toBe(false);
	});

	it('reads the href as a parsed attribute, not as tag text', () => {
		// The old guard tested the serialised tag, so a `>` in a NEIGHBOURING
		// attribute changed what it was looking at. Here the href decides alone.
		const a = anchorAfter('<a title="a>b" href="https://example.com">x</a>');
		expect(a.getAttribute('target')).toBe('_blank');
		// And the neighbour survives intact — the `>` is one character of a
		// value, not a boundary anything is allowed to read.
		expect(a.getAttribute('title')).toBe('a>b');
	});
});

describe('wrapTablesInDom', () => {
	const OLD_SERIALISER_OUTPUT =
		'<p title="<table><img src=/nope onerror=alert(2)>">ok</p>';

	it('⭐ does not let a raw `<table` in an attribute become markup — the string rewrite did', () => {
		expect(
			liveMarkers(wrapTablesAsStringRewrite(OLD_SERIALISER_OUTPUT)),
			'the payload no longer breaks the old string rewrite, so this test proves nothing',
		).toBe(1);
		expect(liveMarkers(throughDom(OLD_SERIALISER_OUTPUT, wrapTablesInDom))).toBe(0);
	});

	it('⭐ still puts every table in a scrollable wrapper', () => {
		const { document } = parseHTML('<html><body><table><tr><td>a</td></tr></table></body></html>');
		wrapTablesInDom(document.body as unknown as ParentNode);
		const wrap = document.querySelector('div.table-wrap');
		expect(wrap, 'the wrapper is gone, so wide tables stretch the message again').not.toBeNull();
		expect(wrap?.querySelector('table')).not.toBeNull();
		// The table's own content survives the move.
		expect(document.querySelector('div.table-wrap table td')?.textContent).toBe('a');
	});

	it('wraps every table, not just the first', () => {
		const { document } = parseHTML('<html><body><table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table></body></html>');
		wrapTablesInDom(document.body as unknown as ParentNode);
		expect(document.querySelectorAll('div.table-wrap').length).toBe(2);
		expect(document.querySelectorAll('div.table-wrap > table').length).toBe(2);
	});

	it('leaves a document without tables untouched', () => {
		const out = throughDom('<p>no tables</p>', wrapTablesInDom);
		expect(out).toBe('<p>no tables</p>');
	});
});
