import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The takeover's English texts quote with “…”, its German ones with „…“ (ux, review of 641c-2).
// Read from the source: `i18n.svelte.ts` holds the locale in a `$state` rune.
const I18N = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf8');
const lines = I18N.split('\n').filter((l) => /^\t'(takeover\.|approvals\.setup\.[a-z_]*taken_over|nav\.paused_badge)/.test(l));

describe('the quotes of the takeover texts', () => {
	it('are typographic in both languages', () => {
		expect(lines.length).toBeGreaterThan(40);
		const bad = lines.filter((l) => {
			const en = /\ben:\s*'((?:[^'\\]|\\.)*)'/.exec(l)?.[1] ?? '';
			const de = /\bde:\s*'((?:[^'\\]|\\.)*)'/.exec(l)?.[1] ?? '';
			return en.includes('"') || en.includes('„') || de.includes('"') || (de.includes('“') && !de.includes('„'));
		});
		expect(bad).toEqual([]);
	});
});
