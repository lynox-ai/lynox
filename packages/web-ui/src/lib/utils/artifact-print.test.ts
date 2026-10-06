import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';

import { injectPrintScaffold } from './artifact-print.js';

/**
 * ⚠ ASSERTIONS IN THIS FILE HAVE MOVED AND THEN CHANGED DIRECTION. Named so the
 * next reader does not have to guess whether a requirement was dropped — and
 * corrected here, because an earlier version of this paragraph described the
 * assertion as "style present, before the close of body" after the assertion
 * itself had been inverted:
 *
 *   · "style before `</head>`" → "style present, before the close of body"
 *     → now "style present, AFTER the close of body". The requirement never
 *     changed: `@page{margin:1.5cm}` has to APPLY. Position was a proxy for
 *     that, and the proxy has been false twice. What applies is measured in a
 *     browser (see `artifact-print.ts`), not here.
 *   · "for a bare fragment the style is PREPENDED" → "the scaffold is present".
 *     Prepend-versus-append for a fragment with no body was incidental; what
 *     kills a prepend now is the `startsWith` assertion on the original.
 *   · "exactly one `window.print()`" is UNCHANGED and still the important one.
 *   · "is case-insensitive about the closing body tag" was RENAMED, not moved:
 *     there is no search any more, so that requirement is gone rather than
 *     satisfied, while `</BODY>` still has to get a working scaffold.
 *
 * The breakout witnesses feed the OLD HTML serialiser's output in as a literal
 * string on purpose — see `external-links.test.ts` for why, and for the measured
 * correction to the reason that used to be given.
 */

/** The shape this change removed, kept verbatim so the payload can be proven live. */
function injectAsPatternMatch(html: string): string {
	const style = '<style>@page{margin:1.5cm}</style>';
	const script = '<scr' + 'ipt>window.addEventListener("load",function(){window.print();});</scr' + 'ipt>';
	let out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${style}</head>`) : `${style}${html}`;
	out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${script}</body>`) : `${out}${script}`;
	return out;
}

/**
 * The shape that REPLACED the pattern match, and was also wrong — kept because
 * it is the only way to show why. For a full document it is safe: the real
 * `</body>` closes the document, so a fake one in an attribute is necessarily
 * before it. For a bare FRAGMENT there is no real one, the last match IS the
 * fake, and the breakout is back. Two tests below use exactly that difference.
 */
function injectAsLastBodyOffset(html: string): string {
	const style = '<style>@page{margin:1.5cm}</style>';
	const script = '<scr' + 'ipt>window.addEventListener("load",function(){window.print();});</scr' + 'ipt>';
	const closes = [...html.matchAll(/<\/body>/gi)];
	const at = closes.length > 0 ? (closes[closes.length - 1]?.index ?? -1) : -1;
	return at < 0 ? `${html}${style}${script}` : `${html.slice(0, at)}${style}${script}${html.slice(at)}`;
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
	it('puts the @page style and the print script into a full document, after it', () => {
		// ⚠ TWO ASSERTIONS HERE CHANGED DIRECTION, and the requirement did not.
		// They used to read `indexOf('@page') < lastIndexOf('</body>')`, i.e.
		// "inside the body" — which was a PROXY for "the rule applies". The
		// scaffold is now appended, so the proxy is false while the requirement
		// holds: measured in Chrome through a blob URL, an appended `<style>` is
		// in the document, its `@page` is a live `CSSPageRule`, and the script
		// runs. What is pinned here is presence and position-at-the-end, because
		// that is what the code promises; whether `@page` APPLIES is a browser
		// fact this suite cannot evaluate and must not pretend to.
		const out = injectPrintScaffold('<html><head><title>X</title></head><body><p>Hi</p></body></html>');
		expect(out).toContain('@page{margin:1.5cm}');
		expect(out.indexOf('@page')).toBeGreaterThan(out.lastIndexOf('</body>'));
		expect(out.indexOf('window.print()')).toBeGreaterThan(out.lastIndexOf('</body>'));
		// Original content preserved, and the document is untouched up to its end.
		expect(out).toContain('<p>Hi</p>');
		expect(out).toContain('<title>X</title>');
		expect(out.startsWith('<html><head><title>X</title></head><body><p>Hi</p></body></html>')).toBe(true);
	});

	it('⭐ carries the print hygiene rules the scaffold exists for', () => {
		// M12: deleting the whole `@media print{…}` block left 30/30 green. The
		// `@page` margin had an assertion; the break-inside/orphans/widows rules
		// that answer the original "zeilenumbrüche schlecht" report had none —
		// and a comment two files over reasons about their cascade position while
		// nothing noticed them being removed.
		const out = injectPrintScaffold('<html><body><p>x</p></body></html>');
		expect(out).toContain('@media print{');
		for (const rule of [
			'tr,img,pre,figure,blockquote{break-inside:avoid}',
			'h1,h2,h3,h4,h5,h6{break-after:avoid;break-inside:avoid}',
			'p,li{orphans:3;widows:3}',
		]) {
			expect(out, `print hygiene rule missing: ${rule}`).toContain(rule);
		}
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

	it('does not care how the closing body tag is cased', () => {
		// This test used to pin a case-INSENSITIVE search, and that requirement
		// is gone rather than satisfied: there is no search. It stays because the
		// behaviour it protects is still a requirement — an artifact written with
		// `</BODY>` gets a working scaffold — and because a reader finding the
		// old name in the history should find the answer here.
		const out = injectPrintScaffold('<HTML><BODY><p>x</p></BODY></HTML>');
		expect(out).toContain('@page{margin:1.5cm}');
		expect((out.match(/window\.print\(\)/g) ?? []).length).toBe(1);
		expect(out).toContain('<p>x</p>');
	});
});

describe('injectPrintScaffold — the precondition the offset shape smuggled in', () => {
	/**
	 * The finding this block exists for. Replacing the pattern match with "the
	 * LAST `</body>`" rested on an argument that is true only for a DOCUMENT:
	 * the real `</body>` closes it, so any fake one in an attribute is before it.
	 * A bare FRAGMENT has no real `</body>` — the last match IS the fake, and the
	 * insertion goes back inside the attribute.
	 *
	 * Neither shipped caller can reach it: `printHtmlDocument` sanitizes with
	 * `WHOLE_DOCUMENT: true` and `printMarkdownDocument` wraps its body in a
	 * full document, so both always produce a real `</body>`. That is exactly
	 * what made it worth fixing rather than noting — the function is exported and
	 * said nothing about needing one, so the next caller would have paid for it.
	 */
	const FRAGMENT_WITH_FAKE_CLOSE =
		'<p title="</body> ><img src=/nope onerror=alert(1)>">ok</p>';

	it('⭐ a fragment carrying a fake `</body>` yields no live markup', () => {
		// Two positive controls, and they are not the same control: the pattern
		// match breaks on this payload, and so does the offset shape that
		// replaced it. If either stops breaking, this test says so rather than
		// passing for nothing.
		expect(
			liveMarkers(injectAsPatternMatch(FRAGMENT_WITH_FAKE_CLOSE)),
			'the pattern match no longer breaks on this payload',
		).toBe(1);
		expect(
			liveMarkers(injectAsLastBodyOffset(FRAGMENT_WITH_FAKE_CLOSE)),
			'the offset shape no longer breaks on this payload — the finding is gone',
		).toBe(1);

		expect(liveMarkers(injectPrintScaffold(FRAGMENT_WITH_FAKE_CLOSE))).toBe(0);
	});

	it('shows why the offset shape passed review: on a DOCUMENT it is safe', () => {
		// The discriminator. Without this the test above reads as "the offset
		// shape was simply broken", which is not what happened — it was correct
		// for every input anyone fed it, and wrong for one nobody had written yet.
		const asDocument =
			'<html><head><title>t</title></head><body>'
			+ '<p title="</body> ><img src=/nope onerror=alert(1)>">ok</p>'
			+ '</body></html>';
		expect(liveMarkers(injectAsPatternMatch(asDocument))).toBe(1);
		expect(liveMarkers(injectAsLastBodyOffset(asDocument))).toBe(0);
		expect(liveMarkers(injectPrintScaffold(asDocument))).toBe(0);
	});

	it('still injects exactly one working scaffold into that fragment', () => {
		// Absence of the attack is not presence of the feature — the same second
		// symptom the document case pins one describe up.
		const out = injectPrintScaffold(FRAGMENT_WITH_FAKE_CLOSE);
		expect((out.match(/window\.print\(\)/g) ?? []).length).toBe(1);
		expect(out).toContain('@page{margin:1.5cm}');
		expect(out.startsWith(FRAGMENT_WITH_FAKE_CLOSE)).toBe(true);
	});
});
