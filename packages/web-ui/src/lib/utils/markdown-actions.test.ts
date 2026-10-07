import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { OWN_MARK, resolveOwnAction } from './markdown-actions.js';

// A click on the markdown view counts only on controls the view built. Message markup can copy a
// control's classes and `data-*`; what it cannot copy is the marker, because the sanitizer drops it.

const doc = (html: string): Document => parseHTML(`<html><body>${html}</body></html>`).document;
const q = (d: Document, sel: string): Element => {
	const el = d.querySelector(sel);
	if (!el) throw new Error(`fixture has no ${sel}`);
	return el;
};

/** The shapes the view builds, with or without the marker. */
const diagram = (m: string): string =>
	`<div class="mermaid-diagram"${m}><div class="diagram-actions"><button class="diagram-btn mermaid-save"${m} data-content="Z3JhcGg="><svg id="save-icon"></svg></button><button class="diagram-btn mermaid-export"${m}>x</button></div><svg></svg></div>`;
const card = (m: string, body = ''): string =>
	`<div class="artifact-container artifact-collapsed"${m} data-html="PHA+" data-title="T"><div class="artifact-toolbar"${m} data-action="toggle"><span>T</span><button class="artifact-btn"${m} data-action="expand">e</button><button class="artifact-btn"${m} data-action="share">s</button><button type="button" class="artifact-chevron">v</button></div><div class="artifact-body">${body}</div></div>`;

describe('the view\'s own controls', () => {
	it('resolve to their action', () => {
		const d = doc(diagram(OWN_MARK) + card(OWN_MARK));
		expect(resolveOwnAction(q(d, '#save-icon'))).toMatchObject({ kind: 'mermaid-save' });
		expect(resolveOwnAction(q(d, '.mermaid-export'))).toMatchObject({ kind: 'mermaid-export', diagram: q(d, '.mermaid-diagram') });
		expect(resolveOwnAction(q(d, '[data-action="expand"]'))).toMatchObject({ kind: 'artifact', action: 'expand', container: q(d, '.artifact-container') });
		expect(resolveOwnAction(q(d, '[data-action="share"]'))).toMatchObject({ kind: 'artifact', action: 'share' });
		expect(resolveOwnAction(q(d, '.artifact-chevron'))).toMatchObject({ kind: 'toggle', container: q(d, '.artifact-container') });
		expect(resolveOwnAction(q(d, '.artifact-toolbar span'))).toMatchObject({ kind: 'toggle' });
	});
});

describe('look-alikes from message markup', () => {
	it('resolve to nothing: same classes and data, no marker', () => {
		const d = doc(diagram('') + card(''));
		for (const sel of ['#save-icon', '.mermaid-export', '[data-action="expand"]', '[data-action="share"]', '.artifact-chevron', '.artifact-toolbar span']) {
			expect(resolveOwnAction(q(d, sel)), sel).toBeNull();
		}
	});

	it('resolve to nothing inside a real card: a copied button in the card body acts on nothing', () => {
		const d = doc(card(OWN_MARK, '<button class="artifact-btn" data-action="expand" id="copy">e</button>'));
		expect(resolveOwnAction(q(d, '#copy'))).toBeNull();
		// The real one in the same card still works.
		expect(resolveOwnAction(q(d, '.artifact-toolbar [data-action="expand"]'))).toMatchObject({ kind: 'artifact', action: 'expand' });
	});

	it('a marked control whose target is not marked acts on nothing', () => {
		const d = doc(`<div class="artifact-container" data-html="PHA+"><button class="artifact-btn"${OWN_MARK} data-action="expand">e</button><div class="artifact-toolbar"${OWN_MARK} data-action="toggle"><span id="bar">t</span></div></div>`
			+ `<div class="mermaid-diagram"><button class="mermaid-export"${OWN_MARK}>x</button><svg></svg></div>`);
		expect(resolveOwnAction(q(d, '.artifact-btn'))).toBeNull();
		expect(resolveOwnAction(q(d, '#bar'))).toBeNull();
		expect(resolveOwnAction(q(d, '.mermaid-export'))).toBeNull();
	});
});

describe('the marker', () => {
	const ACTION_CLASS = /\b(mermaid-save|mermaid-export|mermaid-diagram|artifact-container|artifact-btn|artifact-toolbar)\b/;

	it('is on every control and target the view builds', () => {
		const src = readFileSync(fileURLToPath(new URL('../components/MarkdownRenderer.svelte', import.meta.url)), 'utf8');
		const script = src.slice(0, src.indexOf('</script>'));
		const tags = [...script.matchAll(/<(?:div|button)\b[^>]*\bclass="([^"]*)"[^>]*>/g)].filter((m) => ACTION_CLASS.test(m[1] ?? ''));
		expect(tags.length).toBeGreaterThanOrEqual(11);
		for (const m of tags) expect(m[0], m[0]).toContain('${OWN_MARK}');
	});

	// That the sanitizer removes it is tested on the app's real sanitizing path, in a real DOM:
	// markdown-actions.sanitizer.test.ts.
});
