// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderPromptSegments, unescapeQuoted } from './prompt-markdown.js';
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


// The engine escapes every quote-like character in a value it quotes (`escapeQuoted`), so the
// value cannot close its quote in the question's flat text. In the box the box is the boundary,
// so the value is shown as written; anywhere else the escapes stay.
describe('a quoted value in its box is shown as written', () => {
	const frame = (text: string): RenderablePromptSegment => ({ kind: 'frame', text });
	const value = (text: string): RenderablePromptSegment => ({ kind: 'value', text });

	/** The engine's character class, read as text: this package does not import the engine. */
	function engineQuoteLike(): string {
		let root = process.cwd();
		while (!existsSync(join(root, 'src/tools/dialog-text.ts')) && dirname(root) !== root) root = dirname(root);
		const m = /^const QUOTE_LIKE = (\/\[.*\]\/gu);$/m.exec(readFileSync(join(root, 'src/tools/dialog-text.ts'), 'utf8'));
		return m?.[1] ?? '';
	}
	const ownQuoteLike = (): string => {
		let root = process.cwd();
		while (!existsSync(join(root, 'packages/web-ui/src/lib/utils/prompt-markdown.ts')) && dirname(root) !== root) root = dirname(root);
		return /^const QUOTE_LIKE = (\/\[.*\]\/gu);$/m.exec(readFileSync(join(root, 'packages/web-ui/src/lib/utils/prompt-markdown.ts'), 'utf8'))?.[1] ?? '';
	};
	/** The engine's `escapeQuoted`, from its own character class. */
	const escapeQuoted = (text: string): string => {
		const source = engineQuoteLike();
		const set = new RegExp(source.slice(1, source.lastIndexOf('/')), 'gu');
		return text.replace(set, (c) => `\\${c}`);
	};

	it('escapes the same characters as the engine', () => {
		expect(engineQuoteLike()).not.toBe('');
		expect(ownQuoteLike()).toBe(engineQuoteLike());
	});

	it('undoes exactly what the engine escaped, and nothing else', () => {
		for (const x of ['Keller "Anna" AG', 'Keller AG „Zürich“', 'Offer “final”', 'back\\slash', 'ends with \\', 'two\nlines "q"', '＂wide＂ ❝dingbat❞', 'a\\b \\x \\\\']) {
			expect(unescapeQuoted(escapeQuoted(x)), x).toBe(x);
		}
		// A backslash escapeQuoted did not write stays.
		expect(unescapeQuoted('C:\\temp \\n')).toBe('C:\\temp \\n');
	});

	const question = (lang: 'en' | 'de', name: string): RenderablePromptSegment[] => lang === 'en'
		? [frame('Merge “'), value(escapeQuoted(name)), frame('” into the kept one?')]
		: [frame('„'), value(escapeQuoted(name)), frame('“ zusammenführen?')];

	for (const lang of ['en', 'de'] as const) {
		it(`shows the name as written in its box (${lang})`, () => {
			const doc = new DOMParser().parseFromString(`<div>${renderPromptSegments(question(lang, 'Keller "Anna" AG „Zürich“'), { box: true })}</div>`, 'text/html');
			expect([...doc.querySelectorAll('bdi[data-foreign-value]')].map((e) => e.textContent)).toEqual(['Keller "Anna" AG „Zürich“']);
		});
	}

	it('keeps the escapes where there is no box', () => {
		const doc = new DOMParser().parseFromString(`<div>${renderPromptSegments(question('en', 'Keller "Anna" AG'))}</div>`, 'text/html');
		expect(doc.body.textContent).toContain('Keller \\"Anna\\" AG');
	});

	it('leaves a value that is not between quotation marks as it is, backslashes included', () => {
		const doc = new DOMParser().parseFromString(`<div>${renderPromptSegments([frame('File '), value('a\\"b'), frame(' moves.')], { box: true })}</div>`, 'text/html');
		expect(doc.querySelector('bdi[data-foreign-value]')?.textContent).toBe('a\\"b');
	});

	it('renders the value as text, never as markup', () => {
		const doc = new DOMParser().parseFromString(`<div>${renderPromptSegments(question('en', '<img src=x onerror=1> "x"'), { box: true })}</div>`, 'text/html');
		expect(doc.querySelector('img')).toBeNull();
		expect(doc.querySelector('bdi[data-foreign-value]')?.textContent).toBe('<img src=x onerror=1> "x"');
	});
});
