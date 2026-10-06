import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';

import { injectPrintScaffold } from './artifact-print.js';

/**
 * ⚠ Three assertions in this file MOVED, and each one was pinning a position
 * where the requirement was something else. Named so the next reader does not
 * have to guess whether a requirement was dropped:
 *
 *   · "style before `</head>`" → "style present, before the close of body". The
 *     requirement is that `@page{margin:1.5cm}` APPLIES; a `<style>` element is
 *     valid in body, and moving it there is what removes the second pattern
 *     match rather than hardening it.
 *   · "for a bare fragment the style is PREPENDED" → "the scaffold is present".
 *     Prepend-versus-append for a fragment with no body was incidental.
 *   · "exactly one `window.print()`" is UNCHANGED and still the important one.
 *
 * What is new is the breakout witness, and it feeds the OLD HTML serialiser's
 * output in as a literal string on purpose — see `external-links.test.ts` for
 * why a test that goes through a parser cannot see this class at all.
 */

/** The shape this change removed, kept verbatim so the payload can be proven live. */
function injectAsPatternMatch(html: string): string {
	const style = '<style>@page{margin:1.5cm}</style>';
	const script = '<scr' + 'ipt>window.addEventListener("load",function(){window.print();});</scr' + 'ipt>';
	let out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : `${style}${html}`;
	out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${script}</body>`) : `${out}${script}`;
	return out;
}

/** How many of the attacker's marker elements a document really contains. */
function liveMarkers(html: string): number {
	const { document } = parseHTML(html);
	return document.querySelectorAll('img[src="/nope"]').length;
}

describe('injectPrintScaffold — the breakout it used to allow', () => {
	// What an older `innerHTML` serialiser returns for an artifact that carried
	// `</body>` inside an attribute. The trailing `><img …>` is the attacker's,
	// placed AFTER the insertion point: they cannot inject a raw `"` (even the old
	// spec escaped that), so the quote has to come from the inserted literal and
	// the closing `>` from them.
	const OLD_SERIALISER_OUTPUT =
		'<html><head><title>t</title></head><body>'
		+ '<p title="</body> ><img src=/nope onerror=alert(1)>">ok</p>'
		+ '</body></html>';

	it('⭐ no longer turns a `</body>` inside an attribute into live markup', () => {
		// Positive control for the payload: the shape this replaced breaks on it.
		expect(
			liveMarkers(injectAsPatternMatch(OLD_SERIALISER_OUTPUT)),
			'the payload no longer breaks the old pattern match, so this test proves nothing',
		).toBe(1);
		expect(liveMarkers(injectPrintScaffold(OLD_SERIALISER_OUTPUT))).toBe(0);
	});

	it('still injects exactly one scaffold into that same document', () => {
		// The breakout had a second symptom worth pinning: the insertion landed
		// inside the attribute, so the scaffold's own script went MISSING. Absence
		// of the attack is not the same as presence of the feature.
		const out = injectPrintScaffold(OLD_SERIALISER_OUTPUT);
		expect((out.match(/window\.print\(\)/g) ?? []).length).toBe(1);
		expect(out).toContain('@page{margin:1.5cm}');
	});
});

describe('injectPrintScaffold', () => {
	it('puts the @page style and the print script into a full document, before the body closes', () => {
		const out = injectPrintScaffold('<html><head><title>X</title></head><body><p>Hi</p></body></html>');
		expect(out).toContain('@page{margin:1.5cm}');
		expect(out.indexOf('@page')).toBeLessThan(out.lastIndexOf('</body>'));
		expect(out.indexOf('window.print()')).toBeLessThan(out.lastIndexOf('</body>'));
		// Original content preserved.
		expect(out).toContain('<p>Hi</p>');
		expect(out).toContain('<title>X</title>');
	});

	it('auto-prints and closes after printing', () => {
		const out = injectPrintScaffold('<html><head></head><body></body></html>');
		expect(out).toContain('window.print()');
		expect(out).toContain('afterprint');
		expect(out).toContain('window.close()');
	});

	it('appends the scaffold for a bare fragment with no head/body', () => {
		const out = injectPrintScaffold('<p>just a fragment</p>');
		expect(out).toContain('@page{margin:1.5cm}');
		expect(out).toContain('<p>just a fragment</p>');
		expect(out.trimEnd().endsWith('</scr' + 'ipt>')).toBe(true);
	});

	it('does not double-inject when only the body tag exists', () => {
		const out = injectPrintScaffold('<body><p>x</p></body>');
		expect(out).toContain('@page{margin:1.5cm}');
		expect((out.match(/window\.print\(\)/g) ?? []).length).toBe(1);
	});

	it('is case-insensitive about the closing body tag', () => {
		// `lastIndexOf` is case-sensitive; the search runs over a lowercased copy
		// so an artifact written with `</BODY>` is not treated as a fragment.
		const out = injectPrintScaffold('<HTML><BODY><p>x</p></BODY></HTML>');
		expect(out.indexOf('window.print()')).toBeLessThan(out.toLowerCase().lastIndexOf('</body>'));
	});
});
