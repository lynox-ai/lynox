import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The stage the rest of the suite structurally cannot reach.
 *
 * `renderPromptSegments` hides each value behind a placeholder, renders the
 * frame as markdown, and substitutes the values back afterwards by splitting on
 * the placeholder. The whole mechanism therefore rests on that placeholder
 * surviving two parsers we do not own: `marked`, and then DOMPurify.
 *
 * DOMPurify is the one nothing could see. It is a no-op outside a browser
 * (`typeof DOMPurify.sanitize !== 'function'` → input returned unchanged), so
 * every test in the main file exercises layer 1 only. And the DOM this package
 * does have, `linkedom`, PRESERVES the characters a real browser destroys — so
 * even running those tests in a DOM environment would have stayed green.
 *
 * It was not hypothetical: the placeholder was U+0000, and a browser's HTML
 * parser deletes U+0000 outright (`innerHTML`, `DOMParser` and `<template>`
 * alike, measured in Chrome 150). In the browser every slot vanished, `split`
 * returned a single part, and EVERY interpolated value was silently dropped —
 * "Delete event ? This cannot be undone." with the id gone.
 *
 * ## Why there are TWO fakes and not one
 *
 * The first version of this file used ONE fake that stripped both U+0000 and the
 * private-use range, on the theory that covering both made it mutation-proof
 * against putting the slot back to NUL. It did the opposite. Stripping both makes
 * the two placeholders INDISTINGUISHABLE: every case landed in the degraded
 * path, so the substitution branch was never executed at all, and
 * `renderPromptSegments = (s) => plainTextPrompt(s)` passed the entire file.
 * Verified by running that mutation — 4/4 green.
 *
 * So the fake is parameterised, and the two paths are pinned separately:
 *   - strips ONLY U+0000 → the real slot SURVIVES → the substitution path runs.
 *     Reverting the slot to NUL breaks these, which is the mutation that matters.
 *   - strips ONLY the private-use range → the real slot is eaten → the degraded
 *     path runs. Removing the reconciliation breaks these.
 * A test that cannot tell the two paths apart cannot defend either of them.
 */

/** Set per describe — the mock closure reads it at call time. */
let sanitizerEats: RegExp = /(?!)/;

vi.mock('dompurify', () => ({
	default: {
		sanitize: (html: string): string => html.replace(sanitizerEats, ''),
	},
}));

const { renderPromptSegments, VALUE_SLOT } = await import('./prompt-markdown.js');

const NUL = String.fromCharCode(0);
const frame = (text: string) => ({ kind: 'frame' as const, text });
const value = (text: string) => ({ kind: 'value' as const, text });

describe('layer 2 leaves the slot alone — the substitution path', () => {
	// Eats NUL and nothing else. With the slot at U+E000 this is a no-op, so the
	// real substitution runs; with the slot back at NUL every case below breaks.
	beforeEach(() => {
		sanitizerEats = new RegExp(NUL, 'g');
	});

	it('substitutes the values and keeps the frame markdown', () => {
		const out = renderPromptSegments([frame('**Host:** '), value('api.example.com')]);
		// <strong> proves the markdown path actually ran — the degraded path has none.
		expect(out).toContain('<strong>Host:</strong>');
		expect(out).toContain('api.example.com');
		expect(out).not.toContain('<pre>');
	});

	it('places multiple values in their own slots, in order', () => {
		const out = renderPromptSegments([
			frame('Share '), value('q3.xlsx'),
			frame(' with '), value('finance@example.com'),
			frame(' as '), value('editor'), frame('?'),
		]);
		expect(out).not.toContain('<pre>');
		expect(out.indexOf('q3.xlsx')).toBeLessThan(out.indexOf('finance@example.com'));
		expect(out.indexOf('finance@example.com')).toBeLessThan(out.indexOf('editor'));
	});

	it('still renders a value as text, not markup', () => {
		const out = renderPromptSegments([frame('File: '), value('<img src=x onerror=alert(1)>')]);
		expect(out).not.toMatch(/<img/i);
		expect(out).toContain('&lt;img');
	});

	it('emits no placeholder residue when a SLOT-BEARING FRAME forces the fallback', () => {
		// This case has to live here, under the sanitizer that does NOT eat the
		// slot. Asserting it in the degraded describe was theatre: there the fake
		// strips the private-use range, so it removed the residue itself and the
		// assertion held no matter what the code did — verified, the mutation
		// that drops the strip in `plainTextPrompt` passed all 65 tests.
		//
		// A slot inside a FRAME is the realistic route to the same place: the
		// count reconciles to 2 slots against 1 value, so the fallback fires with
		// the sanitizer leaving the character alone. That is exactly when the
		// degraded path has to strip it itself.
		// BOTH sides carry a slot on purpose. With only a slot-bearing frame,
		// stripping just the frames passed the whole file — and a slot inside a
		// VALUE is the case the docstring actually names (an attacker-controlled
		// mail subject).
		const out = renderPromptSegments([
			frame(`Host${VALUE_SLOT}: `), value(`api${VALUE_SLOT}.example.com`),
		]);
		expect(out).toContain('<pre>');           // the fallback really fired
		expect(out).not.toContain(VALUE_SLOT);    // …and left nothing behind
		expect(out).toContain('api.example.com');
	});
});

describe('layer 2 destroys the slot — the degraded path', () => {
	// Eats the private-use range and nothing else: the real slot vanishes exactly
	// as a browser's parser made U+0000 vanish.
	beforeEach(() => {
		sanitizerEats = /[\uE000-\uF8FF]/g;
	});

	it('still shows every value instead of rendering the frame alone', () => {
		const out = renderPromptSegments([
			frame('Delete event '), value('evt_2026_07_29_a41'), frame('? This cannot be undone.'),
		]);
		// The failure being pinned is silence, not corruption: the old code
		// returned the frame with the id simply absent, and looked fine.
		expect(out).toContain('evt_2026_07_29_a41');
		expect(out).toContain('Delete event');
		expect(out).toContain('This cannot be undone.');
	});

	it('keeps the frame/value distinction instead of flattening both to text', () => {
		// Without this the degraded mode disables the very property the module
		// exists for: with no markup left, a value forging "**Host:**" reads
		// exactly like the system's own label — arguably more like it, since the
		// real one loses its bold.
		const out = renderPromptSegments([
			frame('**Host:** '), value(`attacker.example\n**Host:** api.stripe.com`),
		]);
		expect(out).toContain('<code>');
		const inCode = out.slice(out.indexOf('<code>'), out.indexOf('</code>'));
		expect(inCode).toContain('api.stripe.com');
		expect(inCode).toContain('attacker.example');
		// …and the system's frame is NOT inside the value element.
		expect(out.slice(0, out.indexOf('<code>'))).toContain('Host:');
	});

	it('degrades to escaped text rather than letting a value become markup', () => {
		const out = renderPromptSegments([frame('File: '), value('<img src=x onerror=alert(1)>')]);
		expect(out).not.toMatch(/<img/i);
		expect(out).toContain('&lt;img');
	});

	it('keeps a value readable even when it carries the OLD placeholder', () => {
		// NUL is ordinary content now, and deliberately NOT stripped: the browser's
		// own parser deletes it, and adding a strip here would be code written to
		// satisfy an assertion rather than a requirement. What has to hold is that
		// the value still arrives, inside its value element.
		const out = renderPromptSegments([frame('Host: '), value(`api${NUL}.example.com`)]);
		expect(out).toContain('<code>');
		expect(out.slice(out.indexOf('<code>'), out.indexOf('</code>'))).toContain('.example.com');
	});
});
