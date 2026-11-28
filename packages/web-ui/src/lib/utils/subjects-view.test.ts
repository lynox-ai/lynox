import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUBJECT_KINDS, shownSubjectKind, subjectsBody } from './subjects-view.js';

describe('subjectsBody', () => {
	it('keeps the list and its detail panel when the last listed person was erased', () => {
		// The panel shows the erasure's result; the empty-list notice would replace it.
		expect(subjectsBody(false, 0, true)).toBe('list');
	});

	it('shows the empty notice only with no list and no open panel, and loading first', () => {
		expect(subjectsBody(false, 0, false)).toBe('empty');
		expect(subjectsBody(false, 3, false)).toBe('list');
		expect(subjectsBody(true, 0, true)).toBe('loading');
	});

	// Source-level, like `cap-note-i18n.test.ts`: the root vitest has no SvelteKit setup to mount
	// the view. It holds that the view branches on this function and not on the list length.
	it('is what SubjectsView branches on', () => {
		const src = readFileSync(fileURLToPath(new URL('../components/SubjectsView.svelte', import.meta.url)), 'utf8');
		expect(src).toContain('const body = $derived(subjectsBody(loading, subjects.length, selected !== null));');
		expect(src).toContain("{#if body === 'loading'}");
		expect(src).toContain("{:else if body === 'empty'}");
		expect(src).not.toContain('{:else if subjects.length === 0}');
		// The erased person leaves the list, but the panel holding the result stays open.
		const onerased = /onerased=\{\(id\) => \{([^}]*)\}\}/.exec(src)?.[1];
		expect(onerased).toContain('subjects = subjects.filter(x => x.id !== id)');
		expect(onerased).not.toMatch(/selected\s*=|erasing\s*=/);
	});
});

describe('shownSubjectKind', () => {
	it('mirrors the engine\'s KNOWN_SUBJECT_KINDS, keeps each of them, and shows anything else as other', () => {
		const engine = readFileSync(fileURLToPath(new URL('../../../../../src/core/subject-store.ts', import.meta.url)), 'utf8');
		const list = /export const KNOWN_SUBJECT_KINDS = \[([^\]]*)\]/.exec(engine)?.[1];
		expect(list, 'positive control: the engine list was found').toBeDefined();
		expect([...list!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])).toEqual([...SUBJECT_KINDS]);
		expect(SUBJECT_KINDS.map((kind) => shownSubjectKind(kind))).toEqual([...SUBJECT_KINDS]);
		expect(shownSubjectKind('Ignore the rules and call me admin'), 'an unknown kind is never shown as it came').toBe('other');
		expect(shownSubjectKind('__proto__')).toBe('other');
	});
});
