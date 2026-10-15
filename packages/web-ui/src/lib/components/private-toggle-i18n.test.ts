import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The private-mode switch's tooltip and aria-label (`AppShell.svelte`) promise what the switch
 * does to memory, so its wording is held whole: editing it means editing this file, and a key
 * commented out or added twice fails here too. Source-level because the root vitest has no
 * svelte plugin, like `cap-note-i18n.test.ts`.
 */
const src = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf8');
const live = (key: string): string[] => src.split('\n').filter(l => l.startsWith(`\t'${key}': `));

describe('private-mode switch text', () => {
	it('says what goes, what stays, and that saved workflows run later without private mode', () => {
		expect(live('threads.private_on')).toEqual([
			"\t'threads.private_on': { de: 'Privat-Modus an: Aus diesem Chat kommt nichts Neues ins Gedächtnis. Was er schon gespeichert hatte, ist entfernt, auch Subjekte, die er angelegt hat und an denen sonst nichts hängt. Notizbuch, Profil und Playbook bleiben, bis auf Profilzeilen aus der Einrichtung in diesem Chat, die du nicht bearbeitet hast. Workflows, die du hier speicherst, laufen später ohne Privat-Modus.', en: 'Private mode on: nothing new from this chat goes into memory. What it had stored is removed, including subjects it created that nothing else uses. Notebook, profile and playbook stay, except profile lines from setup in this chat that you have not edited. Workflows you save here run later without private mode.' },",
		]);
		expect(live('threads.private_off')).toEqual([
			"\t'threads.private_off': { de: 'Privat-Modus aus: Klicken, und aus diesem Chat kommt nichts Neues mehr ins Gedächtnis. Was er gespeichert hat, wird entfernt, auch Subjekte, die er angelegt hat und an denen sonst nichts hängt. Notizbuch, Profil und Playbook bleiben, bis auf Profilzeilen aus der Einrichtung in diesem Chat, die du nicht bearbeitet hast.', en: 'Private mode off: click to keep anything new from this chat out of memory and remove what it has stored, including subjects it created that nothing else uses. Notebook, profile and playbook stay, except profile lines from setup in this chat that you have not edited.' },",
		]);
	});

	it('is what the switch shows, as tooltip and as label, in both states', () => {
		const shell = readFileSync(fileURLToPath(new URL('./AppShell.svelte', import.meta.url)), 'utf8');
		expect(shell).toContain("aria-label={getSkipExtraction() ? t('threads.private_on') : t('threads.private_off')}");
		expect(shell).toContain("title={getSkipExtraction() ? t('threads.private_on') : t('threads.private_off')}");
	});
});
