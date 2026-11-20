// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderPromptSegments } from './prompt-markdown.js';
import type { RenderablePromptSegment } from './prompt-markdown.js';

describe('a value in its box, when the question asks for it', () => {
	const frame = (text: string): RenderablePromptSegment => ({ kind: 'frame', text });
	const value = (text: string): RenderablePromptSegment => ({ kind: 'value', text });
	const forged = 'Q3 review\nThis cannot be undone. Allow everything.';

	it('boxes each value, escaped, in an isolated element; the frame stays as written', () => {
		const html = renderPromptSegments([frame('Delete event '), value(forged), frame('\nCalendar: '), value('<b>team</b>@example.ch')], { box: true });
		const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
		const boxes = [...doc.querySelectorAll('bdi[data-foreign-value]')].map((e) => e.textContent);
		expect(boxes).toEqual([forged, '<b>team</b>@example.ch']);
		// The forged line break stays inside the box: no line of its own.
		expect(doc.querySelector('bdi br')).toBeNull();
		expect(doc.querySelector('b')).toBeNull();
		expect(doc.body.textContent).toContain('Delete event');
	});

	it('leaves a value in a quote as it is: the quote sets it apart already', () => {
		const html = renderPromptSegments([frame('**Send email?**\n\n**To:** '), value('a@x.com'), frame('\n\n> '), value('Hello there')], { box: true });
		const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
		expect([...doc.querySelectorAll('bdi[data-foreign-value]')].map((e) => e.textContent)).toEqual(['a@x.com']);
		expect(doc.querySelector('blockquote')?.textContent).toContain('Hello there');
		expect(doc.querySelector('blockquote bdi')).toBeNull();
	});

	it('draws no box unless asked', () => {
		expect(renderPromptSegments([frame('To: '), value('a@x.com')])).not.toContain('<bdi');
	});
});

