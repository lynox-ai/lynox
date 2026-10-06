import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

/**
 * ⚠ THIS FILE REPLACED A SOURCE-TEXT TRIPWIRE, and the reason it could is a
 * claim this file used to make and that was FALSE.
 *
 * It said: the breakout cannot be run, because it needs an engine whose
 * `innerHTML` serialiser returns `<`/`>` raw inside attributes and no current
 * parser does. Measured — `linkedom` is a current parser and it emits raw `<`,
 * `>`, `&` and NBSP in attribute values. So the dangerous round trip is
 * available right here, and "it cannot be run" was the only thing standing
 * between this property and a real witness.
 *
 * The tripwire that stood in for it was a negative on `.replace(`/`.replaceAll(`
 * over this module's source, comment-stripped. An adversarial round put FIVE
 * evasions through it, each measured against a green baseline:
 *
 *   split('<a ').join(…)              a pattern rewrite without `.replace`
 *   ['replace'](…)                    computed member access
 *   .replace (…)                      one space before the paren
 *   /<a /g[Symbol.replace](…)         the protocol method directly
 *   a plain `.replace(` hidden between a `/*` inside a `//` comment
 *     and a later `* /` — the regex stripper deleted the real code
 *
 * The justification for that tripwire was mine and it was wrong in the same way
 * twice: I claimed `String.prototype` has "exactly two" methods that rewrite via
 * a pattern, so the set was CLOSED and could be refused. It is not closed —
 * `split`/`join`, computed access and `Symbol.replace` are all pattern-driven
 * rewrites, and the next one is chosen by whoever writes the next edit. By the
 * rule I was applying, that makes a source negative the wrong instrument.
 *
 * ## What is guarded now, and what is only written down
 *
 * The PROPERTY — "a raw `>` an attacker put in an attribute stays inside that
 * attribute" — is measured below, end to end, on the markdown that produces it.
 * The RULE the module states ("never run a string rewrite over sanitized HTML")
 * is prose, deliberately. It cannot be held mechanically, and an evadable guard
 * is worse than none: it takes the pressure off the rule while reporting green.
 * A rewrite that happens to be safe — anchored before any attribute, say — would
 * violate the rule and pass this witness, and that is the correct split.
 */

/** What the real `DOMPurify.sanitize` was called with, recorded per test. */
let sanitizeCalls: { html: string; opts: unknown }[] = [];

/**
 * ⚠ THE FAKE IS NOT DOMPURIFY, and what it stands in for is narrow.
 *
 * It does no sanitizing at all. What it reproduces is the one thing the defect
 * lives in: the PARSE-AND-SERIALISE ROUND TRIP, where an escaped `&gt;` in the
 * markdown becomes a real `>` character in an attribute value and comes back out
 * raw. DOMPurify's cleaning is not under test here — `tests/security` and
 * DOMPurify's own suite are where that belongs. Using the real thing is not an
 * option: `DOMPurify.sanitize` is not a function outside a browser.
 */
vi.mock('dompurify', () => ({
	default: {
		sanitize: (html: string, opts: unknown) => {
			sanitizeCalls.push({ html, opts });
			const { document } = parseHTML(`<html><body><template>${html}</template></body></html>`);
			const tpl = document.querySelector('template');
			if (!tpl) throw new Error('fake sanitizer lost its template');
			return tpl.content;
		},
	},
}));

const { renderSanitizedMarkdown } = await import('./markdown-render.js');
const { marked } = await import('marked');
const { fixMarkdownPreprocessing, repairCodeFences } = await import('./markdown-preprocess.js');

/**
 * The shape this change removed: the same pipeline, with the two passes as
 * STRING rewrites over the sanitized output. Kept verbatim so every witness
 * below carries its own positive control.
 */
function renderAsStringRewrite(src: string): string {
	const parsed = marked.parse(repairCodeFences(fixMarkdownPreprocessing(src)), { async: false }) as string;
	// The sanitizer's round trip, which is where the raw `>` comes from.
	const { document } = parseHTML(`<html><body><template>${parsed}</template></body></html>`);
	const html = document.querySelector('template')?.innerHTML ?? '';
	return html
		.replace(/<a\b[^>]*>/gi, (tag) => {
			if (/\starget\s*=/i.test(tag)) return tag;
			if (!/\shref\s*=\s*["']https?:\/\//i.test(tag)) return tag;
			return `${tag.slice(0, -1).replace(/\/$/, '')} rel="noreferrer noopener" target="_blank">`;
		})
		.replace(/<table\b[^>]*>/g, '<div class="table-wrap">$&')
		.replace(/<\/table>/g, '</table></div>');
}

/** How many of the attacker's marker elements a string really contains. */
function liveMarkers(html: string): number {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	return document.querySelectorAll('img[src="/nope"]').length;
}

/** A link whose TITLE carries the attacker's payload — content, not a pattern. */
const BREAKOUT = '[x](https://example.com "a><img src=/nope onerror=alert(1)>")';

beforeEach(() => {
	sanitizeCalls = [];
});

describe('the attacker marker and the fake', () => {
	it('⭐ the marker is countable, so a zero below means absence and not blindness', () => {
		expect(liveMarkers('<img src="/nope">')).toBe(1);
		expect(liveMarkers('<p>nothing here</p>')).toBe(0);
	});

	it('⭐ the round trip really produces a RAW `>` inside the attribute', () => {
		// The fixture's own control: if the serialiser ever starts escaping `>` in
		// attribute values, the witnesses below would pass because the payload
		// stopped being dangerous, and this says so instead.
		//
		// ⚠ It deliberately does NOT go through the pipeline. A first version did,
		// and then an overrunning rewrite INSIDE the pipeline failed this test
		// too — so the first message a developer saw was "the serialiser now
		// escapes `>`", which is the wrong cause. A control whose path includes
		// the subject cannot tell the two apart. Subject here is the serialiser
		// and nothing else.
		const { document } = parseHTML('<html><body></body></html>');
		const el = document.createElement('p');
		el.setAttribute('title', 'a><img src=/nope>');
		document.body.appendChild(el);
		expect(
			document.body.innerHTML,
			'the serialiser now escapes `>` in attributes — the witnesses below prove nothing',
		).toMatch(/title="[^"]*>/);
	});
});

describe('renderSanitizedMarkdown', () => {
	it('⭐ keeps a raw `>` in an attribute inside that attribute — the string rewrite did not', () => {
		// Positive control: the shape this replaced breaks on this very markdown.
		expect(
			liveMarkers(renderAsStringRewrite(BREAKOUT)),
			'the payload no longer breaks the string rewrite, so this test proves nothing',
		).toBe(1);

		// And the pipeline that replaced it does not.
		expect(liveMarkers(renderSanitizedMarkdown(BREAKOUT))).toBe(0);
	});

	it('⭐ asks the sanitizer for NODES, which is what makes the passes node passes', () => {
		// Observed from the real call, not read out of the source. A string-mode
		// sanitize would hand the passes a string and they would have nothing to
		// walk — so this is the option the whole shape rests on.
		renderSanitizedMarkdown('plain text');
		expect(sanitizeCalls.length).toBe(1);
		expect(sanitizeCalls[0]?.opts).toEqual({ RETURN_DOM_FRAGMENT: true });
	});

	it('⭐ still does the work: an off-site link gets a new tab and a safe rel', () => {
		const { document } = parseHTML(
			`<html><body>${renderSanitizedMarkdown('[x](https://example.com/x)')}</body></html>`,
		);
		const a = document.querySelector('a');
		expect(a, 'the link pass did not run').not.toBeNull();
		expect(a?.getAttribute('target')).toBe('_blank');
		expect(a?.getAttribute('rel')).toBe('noreferrer noopener');
	});

	it('⭐ still does the work: a table gets its scroll wrapper', () => {
		const { document } = parseHTML(
			`<html><body>${renderSanitizedMarkdown('| a |\n| - |\n| b |')}</body></html>`,
		);
		expect(document.querySelector('div.table-wrap table'), 'the table pass did not run').not.toBeNull();
	});

	it('runs the preprocessors on the raw source, upstream of the sanitizer', () => {
		// This is the stage a string rewrite is LEGITIMATE at — the markdown is
		// not sanitized markup yet. The old tripwire reddened on it, which is one
		// of the two reasons it is gone.
		renderSanitizedMarkdown('```js\nconst x = 1;\n');
		expect(sanitizeCalls[0]?.html, 'the fence repair did not reach the sanitizer').toContain('<code');
	});
});

describe('the renderer routes through it', () => {
	/**
	 * The one thing a run cannot show: that the component still calls this. A
	 * rename reddens this test, which is correct — a test names what it depends
	 * on. What it does NOT cover: a second pipeline added beside this one.
	 */
	it('⭐ MarkdownRenderer renders its markdown through this module', () => {
		const renderer = readFileSync(
			fileURLToPath(new URL('../components/MarkdownRenderer.svelte', import.meta.url)),
			'utf-8',
		);
		expect(
			renderer,
			'MarkdownRenderer no longer calls renderSanitizedMarkdown — the pipeline is back in the component',
		).toContain('renderSanitizedMarkdown(');
	});
});
