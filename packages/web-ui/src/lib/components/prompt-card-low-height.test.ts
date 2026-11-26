import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * With little height (a phone in landscape with the keyboard open, a small window) a long
 * permission question used to push its Allow/Deny buttons below the prompt stack's visible part,
 * under the input, and the transcript collapsed to a few pixels behind it.
 *
 * The layout that keeps the buttons in view is a chain of flex rules, and each link is needed:
 * the stack is a flex column, the card and its inner column may shrink (`min-h-0`), and only the
 * question row gives way, its block scrolling within. The transcript keeps a strip of its own.
 *
 * There is no layout engine in this package's tests, so the measurement lives in the shots (both
 * buttons fully visible at 340 and 460 px height, 390 and 1440 wide). This pins the chain in the
 * template, the instrument `secret-prompt-frame.test.ts` uses on this file for the same reason.
 */
const CHATVIEW = readFileSync(fileURLToPath(new URL('./ChatView.svelte', import.meta.url)), 'utf-8');
const SRC = fileURLToPath(new URL('../../', import.meta.url));

/** The classes of the one opening tag that carries `marker`. */
function classesOf(marker: string): string[] {
	const tags = [...CHATVIEW.matchAll(/<div\b[^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes(marker));
	expect(tags, `exactly one tag carries ${marker}`).toHaveLength(1);
	const cls = /\bclass="([^"]*)"/.exec(tags[0]!);
	expect(cls, `${marker} has a class attribute`).not.toBeNull();
	return cls![1]!.split(/\s+/).filter(Boolean);
}

/** The permission card's markup, from its opening tag to the first button group after the question row. */
function permissionCard(): string {
	const start = CHATVIEW.indexOf('data-pending-prompt data-prompt-kind="permission"');
	expect(start).toBeGreaterThan(0);
	const end = CHATVIEW.indexOf('{#if isDeepConsent}', start);
	expect(end).toBeGreaterThan(start);
	return CHATVIEW.slice(start, end);
}

describe('a long permission question at little height', () => {
	it('the prompt stack is a flex column that may shrink and scroll', () => {
		const cls = classesOf('data-chat-stack');
		for (const c of ['flex', 'flex-col', 'min-h-0', 'overflow-y-auto', 'max-h-[60%]']) expect(cls, c).toContain(c);
	});

	it('the engine\'s confirmation card, its inner column and its question row may shrink, unless too low', () => {
		expect(CHATVIEW).toContain("{@const shrinks = (isPermissionGuard || isDeepConsent) && !promptTooLow}");
		const card = classesOf('data-prompt-kind="permission"');
		const inner = /<div\b[^>]*>/.exec(permissionCard().slice(permissionCard().indexOf('>') + 1));
		expect(inner).not.toBeNull();
		const innerCls = /\bclass="([^"]*)"/.exec(inner![0])![1]!.split(/\s+/);
		const row = classesOf('data-prompt-question-row');
		for (const [name, cls] of [['card', card], ['inner', innerCls], ['row', row]] as const) {
			expect(cls, name).toContain('flex');
			expect(cls.join(' '), name).toContain("{shrinks ? 'min-h-0' : ''}");
		}
		expect(card).toContain('flex-col');
		expect(innerCls).toContain('flex-col');
		expect(row).toContain('items-stretch');
		expect(row).not.toContain('items-start');
	});

	it('the engine\'s confirmation shows its question through the field with the head and the count', () => {
		const card = permissionCard();
		expect(card).toContain('<PromptQuestionField head={split.head} lines={split.lines} bind:tooLow={promptTooLow} />');
		expect(card).toContain('{@const split = splitPromptHead(pendingPermission.question, pendingPermission.segments)}');
	});

	it('the buttons are outside the question row, so they never scroll with it', () => {
		const card = permissionCard();
		const rowAt = card.indexOf('data-prompt-question-row');
		expect(rowAt).toBeGreaterThan(0);
		expect(card.slice(rowAt)).not.toContain("answerPrompt('allow'");
		expect(CHATVIEW.indexOf("answerPrompt('allow'")).toBeGreaterThan(CHATVIEW.indexOf('{#if isDeepConsent}', CHATVIEW.indexOf('data-prompt-question-row')));
	});

	it('the transcript keeps a strip of its own instead of collapsing behind the stack', () => {
		const cls = classesOf('data-chat-transcript');
		expect(cls).toContain('min-h-12');
		expect(cls).toContain('flex-1');
	});
});

describe('a question without a consent kind that runs past its box', () => {
	// The model's own question and a tool's confirmation (a sheet's formulas, a mail) are rendered
	// markup in a box of fixed height. Its end may be what the yes is for, so a count and a fade say
	// that more follows, as the engine's own confirmation does. The measurement is in the shots.
	const boxTag = (): string => {
		const tags = [...CHATVIEW.matchAll(/<div\b[^>]*>/g)].map((m) => m[0]).filter((t) => t.includes('data-prompt-markdown'));
		expect(tags).toHaveLength(1);
		return tags[0]!;
	};

	it('its box is the card\'s one box with that mark, measured again when it scrolls', () => {
		expect(permissionCard()).toContain(boxTag());
		expect(boxTag()).toContain('onscroll={measureQuestion}');
		expect(CHATVIEW).toContain("document.querySelector<HTMLElement>('[data-pending-prompt] [data-prompt-markdown]')");
		// No other file of the web UI carries the mark, so the lookup cannot land elsewhere.
		const files = readdirSync(SRC, { recursive: true, encoding: 'utf-8' }).filter((f) => /\.(svelte|ts)$/.test(f) && !/\.test\.ts$/.test(f));
		expect(files.filter((f) => readFileSync(join(SRC, f), 'utf-8').includes('data-prompt-markdown')).map((f) => f.replace(/\\/g, '/'))).toEqual(['lib/components/ChatView.svelte']);
	});

	it('the box scrolls and cuts nothing off any other way', () => {
		const cls = boxTag().match(/\bclass="([^"]*)"/)![1]!.split(/\s+/);
		expect(cls).toContain('max-h-64');
		expect(cls).toContain('overflow-y-auto');
		expect(cls.filter((c) => /(^|:)(overflow-hidden|overflow-y-hidden|overflow-clip|truncate|line-clamp-|hidden$|invisible|h-0$|max-h-0)/.test(c))).toEqual([]);
	});

	it('the fade sits on the box, in a frame of its own, only while lines lie below', () => {
		const card = permissionCard();
		const frame = card.slice(card.lastIndexOf('<div class="relative flex min-w-0 flex-col">', card.indexOf('data-prompt-markdown')));
		expect(frame.startsWith('<div class="relative flex min-w-0 flex-col">')).toBe(true);
		const fadeIf = frame.slice(frame.indexOf('</div>', frame.indexOf('data-prompt-markdown')));
		expect(fadeIf).toMatch(/^<\/div>\s*\{#if questionBelow > 0\}\s*<div data-prompt-fade class="pointer-events-none absolute inset-x-0 bottom-0 h-8 [^"]*"><\/div>\s*\{\/if\}\s*<\/div>/);
	});

	it('the button with the count stands under the box, only while lines lie below', () => {
		const card = permissionCard();
		const afterFrame = card.slice(card.indexOf('{/if}', card.indexOf('data-prompt-fade')) + '{/if}'.length);
		expect(afterFrame).toMatch(/^\s*<\/div>\s*\{#if questionBelow > 0\}\s*<div class="flex shrink-0 justify-end pt-1">\s*<button data-prompt-read-more type="button" onclick=\{readOnQuestion\} [^>]*>\{questionBelowLabel\} <span aria-hidden="true">↓<\/span><\/button>\s*<\/div>\s*\{\/if\}/);
		expect(CHATVIEW).toContain("questionBelow === 1 ? t('chat.prompt_read_more_one') : tf('chat.prompt_read_more', { n: String(questionBelow) })");
	});
});
