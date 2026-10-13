import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { subjectsBody } from './subjects-view.js';

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
	});
});
