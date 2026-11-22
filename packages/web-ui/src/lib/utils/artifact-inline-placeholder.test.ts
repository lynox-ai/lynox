// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	containsEvictionMarker,
	EVICTION_NOTE,
	LEGACY_EVICTION_NOTE,
} from '../../../../../src/core/artifact-eviction.js';
import {
	artifactFenceHeader,
	fenceHoldsOnlyPlaceholder,
	holdsOnlyPlaceholder,
	PLACEHOLDER_MAX_BYTES,
	resolveArtifactRender,
	withPlaceholderBadge,
} from './artifact-inline.js';
import { parseFences } from './code-fences.js';
import { renderSanitizedMarkdown } from './markdown-render.js';

// The engine's placeholder as a damaged file holds it (measured on a real instance: 176 bytes).
const OLD_FORM = '[evicted after successful save — 5251 chars. The artifact is persisted; its id and file path are in the tool result below. read_file that path if you need the content again.]';

/** The store marks a file by this rule (`isLostOnSave` in src/core/artifact-store.ts). */
const storeRule = (s: string): boolean => new TextEncoder().encode(s).length <= PLACEHOLDER_MAX_BYTES && containsEvictionMarker(s);

describe('an inline artifact that holds only the engine\'s placeholder', () => {
	const cases: Array<[string, string]> = [
		['the old in-field form', OLD_FORM],
		['the note', EVICTION_NOTE.trim()],
		['the legacy note', LEGACY_EVICTION_NOTE.trim()],
		['the note under a heading', `# Pitch\n\n${EVICTION_NOTE.trim()}`],
		['the old form after a title marker', `<!-- title: Pitch -->\n${OLD_FORM}`],
		['a document', '# Pitch\n\nOur offer for the spring season.'],
		['a document that names a placeholder in words', '# Notes\n\nThe engine writes a placeholder where a saved body was.'],
		['an empty body', ''],
	];

	it.each(cases)('agrees with the store\'s rule on %s', (_l, body) => {
		expect(holdsOnlyPlaceholder(body)).toBe(storeRule(body));
	});

	it('positive control: the cases hold both answers', () => {
		const answers = new Set(cases.map(([, body]) => storeRule(body)));
		expect(answers).toEqual(new Set([true, false]));
	});

	it('uses the store\'s size bound, read from the store', () => {
		// From the repo root: every vitest run starts there (packages/web-ui/vitest.config.ts), and under
		// jsdom `import.meta.url` is not a file URL.
		const store = readFileSync(join(process.cwd(), 'src/core/artifact-store.ts'), 'utf8');
		const bound = /const LOST_ON_SAVE_MAX_BYTES = (\d+);/.exec(store);
		expect(bound, 'the store still declares its bound').not.toBeNull();
		expect(PLACEHOLDER_MAX_BYTES).toBe(Number(bound![1]));
	});

	it('a placeholder inside a body over the bound is a document that quotes it: no badge', () => {
		const atBound = OLD_FORM + 'x'.repeat(PLACEHOLDER_MAX_BYTES - new TextEncoder().encode(OLD_FORM).length);
		expect(holdsOnlyPlaceholder(atBound), 'at the bound it still counts').toBe(true);
		expect(holdsOnlyPlaceholder(atBound + 'x')).toBe(false);
	});

	it('counts the bound in bytes, as the store does, not in characters', () => {
		// Under the bound in characters, over it in UTF-8 bytes.
		const body = OLD_FORM + 'ä'.repeat(1000);
		expect(body.length).toBeLessThanOrEqual(PLACEHOLDER_MAX_BYTES);
		expect(holdsOnlyPlaceholder(body)).toBe(false);
	});
});

describe('which inline card gets the badge', () => {
	/** A stored placeholder of exactly `bytes` bytes: the old form, padded. */
	const stored = (bytes: number): string => OLD_FORM + 'x'.repeat(bytes - new TextEncoder().encode(OLD_FORM).length);
	/** The fence code MarkdownRenderer's buildArtifact receives, through the renderer's own steps:
	 *  the fence as the chat writes it (`artifactFenceWrap` in ChatView), the markdown render and
	 *  the fence parse. */
	const throughRenderer = (fenceBody: string): string => {
		const fences = parseFences(renderSanitizedMarkdown('```artifact\n' + fenceBody + '\n```'), document).fences;
		expect(fences, 'the fence reaches the renderer as one artifact fence').toHaveLength(1);
		return fences[0]!.code;
	};
	/** A card the chat builds from a save, as ChatView builds it: the header decides `lost` from the content. */
	const chatCard = (content: string, typed: boolean): string =>
		throughRenderer(artifactFenceHeader({ title: 'Ein längerer Titel für das Angebot', type: 'markdown', id: 'abc123', typed, lost: holdsOnlyPlaceholder(content) }) + content);

	it.each([['an untyped card', false], ['a typed card', true]])('%s from a save: the store\'s answer on the content, exactly at the bound and one byte over', (_l, typed) => {
		expect(holdsOnlyPlaceholder(chatCard(stored(PLACEHOLDER_MAX_BYTES), typed)), 'positive control: measured as it arrives, the fence is over the bound').toBe(false);
		expect(fenceHoldsOnlyPlaceholder(chatCard(stored(PLACEHOLDER_MAX_BYTES), typed))).toBe(true);
		expect(fenceHoldsOnlyPlaceholder(chatCard(stored(PLACEHOLDER_MAX_BYTES + 1), typed))).toBe(false);
		expect(fenceHoldsOnlyPlaceholder(chatCard('# Pitch\n\nOur offer.', typed))).toBe(false);
	});

	it('the marker is not part of what the card renders', () => {
		const { src, lost } = resolveArtifactRender(chatCard(OLD_FORM, false));
		expect(lost).toBe(true);
		expect(src).not.toContain('lynox-artifact-lost');
		expect(src).toContain(OLD_FORM);
	});

	it('a fence the model wrote is measured as it stands: it can miss a badge at the bound, never show one over it', () => {
		// The parser adds a line end, so the measured text is one byte longer than the model's.
		expect(fenceHoldsOnlyPlaceholder(throughRenderer(stored(PLACEHOLDER_MAX_BYTES - 1)))).toBe(true);
		expect(fenceHoldsOnlyPlaceholder(throughRenderer(stored(PLACEHOLDER_MAX_BYTES)))).toBe(false);
		// Nothing is stripped before measuring: leading whitespace still counts.
		expect(fenceHoldsOnlyPlaceholder(throughRenderer(' '.repeat(1500) + OLD_FORM + 'x'.repeat(500)))).toBe(false);
		expect(fenceHoldsOnlyPlaceholder(throughRenderer('# Pitch\n\nOur offer.'))).toBe(false);
	});

	it('a fence the model wrote with a title comment of its own is not checked', () => {
		expect(fenceHoldsOnlyPlaceholder(throughRenderer(`<!-- title: Pitch -->\n${OLD_FORM}`))).toBe(false);
	});
});

describe('the badge on the inline card', () => {
	const card = `<div class="artifact-container artifact-collapsed" data-title="Pitch">
			<div class="artifact-toolbar" data-action="toggle">
				<span class="artifact-label">HTML</span>
				<span class="artifact-title">Pitch</span>
				<button class="artifact-btn" data-action="expand" title="Expand"></button>
			</div>
		</div>`;

	it('sits right after the title and carries the label as text and tooltip', () => {
		const out = withPlaceholderBadge(card, 'Inhalt fehlt');
		const el = document.createElement('div');
		el.innerHTML = out;
		const badge = el.querySelector('[data-testid="artifact-inline-lost-badge"]');
		expect(badge?.textContent).toBe('Inhalt fehlt');
		expect(badge?.getAttribute('title')).toBe('Inhalt fehlt');
		expect(badge?.previousElementSibling?.className).toBe('artifact-title');
		expect(el.querySelectorAll('[data-testid="artifact-inline-lost-badge"]')).toHaveLength(1);
	});

	it('escapes the label', () => {
		const el = document.createElement('div');
		el.innerHTML = withPlaceholderBadge(card, '<img src=x onerror=alert(1)> "a"');
		const badge = el.querySelector('[data-testid="artifact-inline-lost-badge"]')!;
		expect(badge.querySelector('img')).toBeNull();
		expect(badge.textContent).toBe('<img src=x onerror=alert(1)> "a"');
	});

	it('shows a label with replacement patterns as written', () => {
		const el = document.createElement('div');
		el.innerHTML = withPlaceholderBadge(card, "a $& b $' c");
		expect(el.querySelector('[data-testid="artifact-inline-lost-badge"]')!.textContent).toBe("a $& b $' c");
	});

	it('leaves a card without a title span unchanged', () => {
		const bare = '<div class="artifact-container"></div>';
		expect(withPlaceholderBadge(bare, 'Inhalt fehlt')).toBe(bare);
	});
});
