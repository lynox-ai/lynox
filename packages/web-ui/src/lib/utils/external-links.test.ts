import { describe, it, expect } from 'vitest';

import { externalizeLinks } from './external-links.js';

/**
 * A user reported research links as "not clickable". They were clickable — GFM
 * autolinking turns bare URLs into anchors — but undecorated and, when clicked,
 * they navigated the whole app away. The prompt renderer one directory over has
 * always set `target="_blank"`; the chat renderer never did.
 */
describe('externalizeLinks', () => {
	// ⭐ THE POINT: an off-site link opens in a new tab instead of replacing the app.
	it('⭐ sends an absolute http(s) link to a new tab, with a safe rel', () => {
		const out = externalizeLinks('<a href="https://example.com/x">x</a>');
		expect(out).toContain('target="_blank"');
		expect(out).toContain('rel="noreferrer noopener"');
		// The href and the visible text survive untouched.
		expect(out).toContain('href="https://example.com/x"');
		expect(out).toContain('>x</a>');
	});

	it('handles http as well as https', () => {
		expect(externalizeLinks('<a href="http://example.com">x</a>')).toContain('target="_blank"');
	});

	// ⭐ The opposite direction, and it is the one a careless fix breaks: in-app
	// navigation must stay in this tab. Sending it to a new tab would not be a
	// smaller bug than the one being fixed.
	it('⭐ leaves in-app and fragment links navigating in place', () => {
		for (const html of [
			'<a href="/threads/42">t</a>',
			'<a href="#section">s</a>',
			'<a href="?tab=x">q</a>',
			'<a href="relative/path">r</a>',
		]) {
			expect(externalizeLinks(html)).toBe(html);
		}
	});

	// A scheme that is neither http nor https is not ours to open. DOMPurify has
	// already run, so `javascript:` should never arrive — but this function must
	// not be the reason it would matter.
	it('does not touch mailto, tel, or other schemes', () => {
		for (const html of [
			'<a href="mailto:info@i-restore.ch">mail</a>',
			'<a href="tel:+41000000000">call</a>',
			'<a href="ftp://example.com/f">f</a>',
		]) {
			expect(externalizeLinks(html)).toBe(html);
		}
	});

	// A renderer that already made its own decision keeps it — no double target.
	it('leaves an anchor that already declares a target alone', () => {
		const html = '<a href="https://example.com" target="_self">x</a>';
		expect(externalizeLinks(html)).toBe(html);
	});

	it('rewrites every external link in a document, not just the first', () => {
		const out = externalizeLinks(
			'<p><a href="https://a.test">a</a> und <a href="https://b.test">b</a> und <a href="/local">l</a></p>',
		);
		expect(out.match(/target="_blank"/g)).toHaveLength(2);
		expect(out).toContain('<a href="/local">l</a>');
	});

	// Attributes marked's autolinker and DOMPurify actually emit must survive.
	it('keeps existing attributes on the anchor', () => {
		const out = externalizeLinks('<a href="https://example.com" title="T" class="c">x</a>');
		expect(out).toContain('title="T"');
		expect(out).toContain('class="c"');
		expect(out).toContain('target="_blank"');
	});

	// The anchor may be self-closed by an upstream serializer; the rewrite must
	// not leave a stray slash before the added attributes.
	it('does not emit a malformed tag for a self-closed anchor', () => {
		const out = externalizeLinks('<a href="https://example.com"/>');
		expect(out).not.toContain('/ rel=');
		expect(out).toContain('target="_blank">');
	});

	it('leaves markup without links unchanged', () => {
		const html = '<p>kein Link, nur <code>https://example.com</code> als Text</p>';
		expect(externalizeLinks(html)).toBe(html);
	});
});
