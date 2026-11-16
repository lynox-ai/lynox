import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The words of a tool row's outcome, as they were set (U-291). Read from the dictionary source so
// both languages are held, not only the one the test runs in.
describe('the words of the tool row', () => {
	it('are the ones that were set, in both languages', () => {
		const src = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf8');
		expect(src).toContain("'chat.tool.unsuccessful': { de: 'ohne Erfolg', en: 'unsuccessful' },");
		expect(src).toContain("'chat.tool.status_done': { de: 'erledigt', en: 'done' },");
		expect(src).toContain("'chat.tool.status_error': { de: 'Fehler', en: 'error' },");
	});
});
