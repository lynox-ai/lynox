import { describe, it, expect, vi } from 'vitest';

/**
 * The stage the rest of the suite structurally cannot reach.
 *
 * `renderPromptSegments` hides each value behind a placeholder, renders the
 * frame as markdown, and substitutes the values back afterwards. That last step
 * splits on the placeholder — so the whole mechanism rests on the placeholder
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
 * "Delete event ? This cannot be undone." with the id gone, on the surface whose
 * entire job is telling an approver what they are approving.
 *
 * So these tests replace layer 2 with a sanitizer that eats the placeholder, and
 * assert the values still reach the reader. The fake strips BOTH the old NUL and
 * the private-use range the current slot lives in, deliberately: a mutation that
 * puts the placeholder back to NUL must still fail here rather than sail past a
 * fake that only knows about the new one.
 */
vi.mock('dompurify', () => ({
	default: {
		sanitize: (html: string): string => html.replace(/[\u0000\uE000-\uF8FF]/g, ''),
	},
}));

const { renderPromptSegments } = await import('./prompt-markdown.js');

const frame = (text: string) => ({ kind: 'frame' as const, text });
const value = (text: string) => ({ kind: 'value' as const, text });

describe('renderPromptSegments — when layer 2 destroys the placeholder', () => {
	it('still shows every value instead of rendering the frame alone', () => {
		const out = renderPromptSegments([
			frame('Delete event '),
			value('evt_2026_07_29_a41'),
			frame('? This cannot be undone.'),
		]);

		// The failure being pinned is silence, not corruption: the old code
		// returned the frame with the id simply absent, and looked fine.
		expect(out).toContain('evt_2026_07_29_a41');
		expect(out).toContain('Delete event');
		expect(out).toContain('This cannot be undone.');
	});

	it('keeps every value of a multi-value prompt, in order', () => {
		const out = renderPromptSegments([
			frame('Share '),
			value('q3-forecast.xlsx'),
			frame(' with '),
			value('finance@example.com'),
			frame(' as '),
			value('editor'),
			frame('?'),
		]);

		for (const needle of ['q3-forecast.xlsx', 'finance@example.com', 'editor']) {
			expect(out).toContain(needle);
		}
		expect(out.indexOf('q3-forecast.xlsx')).toBeLessThan(out.indexOf('finance@example.com'));
		expect(out.indexOf('finance@example.com')).toBeLessThan(out.indexOf('editor'));
	});

	it('degrades to escaped text rather than letting a value become markup', () => {
		// The fallback must not buy visibility back at the price this module
		// exists to prevent: the value is still text, not an element.
		const out = renderPromptSegments([
			frame('File: '),
			value('<img src=x onerror=alert(1)>'),
		]);

		expect(out).not.toMatch(/<img/i);
		expect(out).toContain('&lt;img');
	});

	it('leaves no placeholder residue in what the approver sees', () => {
		const out = renderPromptSegments([frame('Host: '), value('api.example.com')]);
		expect(out).not.toMatch(/[\u0000\uE000-\uF8FF]/);
	});
});
