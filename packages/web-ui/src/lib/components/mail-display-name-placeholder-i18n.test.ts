import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The sender-name field shows a placeholder, and recipients later see exactly the name typed
 * there as the sender. The placeholder therefore shows the format, not a name that could pass for
 * a value already filled in. Source-level because the root vitest has no svelte plugin, like
 * `private-toggle-i18n.test.ts`.
 */
const src = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf8');
const live = (key: string): string[] => src.split('\n').filter(l => l.startsWith(`\t'${key}': `));

describe('sender-name placeholder', () => {
	it('shows the format in both languages', () => {
		expect(live('mail.display_name_placeholder')).toEqual([
			"\t'mail.display_name_placeholder': { de: 'Vorname Nachname', en: 'First Last' },",
		]);
	});

	it('is what the field shows, and the field carries no fixed placeholder', () => {
		const view = readFileSync(fileURLToPath(new URL('./MailSettings.svelte', import.meta.url)), 'utf8');
		const field = view.slice(view.indexOf('bind:value={formDisplayName}'), view.indexOf('data-testid="mail-display-name-input"'));
		expect(field).toContain("placeholder={t('mail.display_name_placeholder')}");
		expect(field).not.toMatch(/placeholder="/);
	});
});
