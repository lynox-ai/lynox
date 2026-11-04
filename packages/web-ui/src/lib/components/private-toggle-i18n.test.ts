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
			"\t'threads.private_on': { de: 'Privat-Modus an: Aus diesem Chat kommt nichts Neues ins Gedächtnis. Was nur dieser Chat gespeichert hatte, ist entfernt, auch Subjekte, die er angelegt hat und an denen sonst nichts hängt. Notizbuch, Profil und Playbook bleiben, bis auf Profilzeilen aus der Einrichtung in diesem Chat, die du nicht bearbeitet hast. Workflows, die du hier speicherst, laufen später ohne Privat-Modus.', en: 'Private mode on: nothing new from this chat goes into memory. What only this chat had stored is removed, including subjects it created that nothing else uses. Notebook, profile and playbook stay, except profile lines from setup in this chat that you have not edited. Workflows you save here run later without private mode.' },",
		]);
		expect(live('threads.private_off')).toEqual([
			"\t'threads.private_off': { de: 'Privat-Modus aus: Klicken, und aus diesem Chat kommt nichts Neues mehr ins Gedächtnis. Was nur dieser Chat gespeichert hat, wird entfernt, auch Subjekte, die er angelegt hat und an denen sonst nichts hängt. Notizbuch, Profil und Playbook bleiben, bis auf Profilzeilen aus der Einrichtung in diesem Chat, die du nicht bearbeitet hast.', en: 'Private mode off: click to keep anything new from this chat out of memory and remove what only this chat has stored, including subjects it created that nothing else uses. Notebook, profile and playbook stay, except profile lines from setup in this chat that you have not edited.' },",
		]);
	});

	it('is what the switch shows, as tooltip and as label, in both states', () => {
		const shell = readFileSync(fileURLToPath(new URL('./AppShell.svelte', import.meta.url)), 'utf8');
		expect(shell).toContain("aria-label={headerContained ? headerContainedText : getSkipExtraction() ? t('threads.private_on') : t('threads.private_off')}");
		expect(shell).toContain("title={headerContained ? headerContainedText : getSkipExtraction() ? t('threads.private_on') : t('threads.private_off')}");
		// The locked text says what the engine could tell: read store data, or could not check.
		expect(shell).toMatch(/const headerContainedText = \$derived\(\s*containedTextKeys\('locked', getThreadContained\(\)\s*\? getThreadContainedUnknown\(\)\s*: readContainedUnknown\(getThreads\(\)\.find\(\(thr\) => thr\.id === getSessionId\(\)\)\?\.contained_unknown\)\)\.map\(\(k\) => t\(k\)\)\.join\(' '\),\s*\);/);
	});
});

describe('the switch of a contained chat (read data through a store connection)', () => {
	const shell = readFileSync(fileURLToPath(new URL('./AppShell.svelte', import.meta.url)), 'utf8');

	it('is locked, and shows private mode on', () => {
		// aria-disabled, not disabled: a disabled button leaves the tab order, and the reason with it.
		expect(shell).toContain('aria-disabled={headerContained}');
		expect(shell).toContain('onclick={() => { if (!headerContained) void toggleSkipExtraction(); }}');
		expect(shell).not.toMatch(/\sdisabled=\{headerContained\}/);
		expect(shell).toContain('{#if headerContained || getSkipExtraction()}');
		// Read from the opened thread, or from the list after a run contained the chat.
		expect(shell).toMatch(/const headerContained = \$derived\(\s*getThreadContained\(\) \|\| getThreads\(\)\.find\(\(thr\) => thr\.id === getSessionId\(\)\)\?\.contained === true,\s*\);/);
	});

	it('the list badge names it', () => {
		expect(shell).toContain("aria-label={thread.contained ? t(containedTextKeys('badge', readContainedUnknown(thread.contained_unknown))[0]!) : t('threads.private')}");
		expect(shell).toContain('{#if thread.is_favorite || thread.skip_extraction || thread.contained}');
	});

	it('says why in both languages, word for word (business-planning 2026-10-19)', () => {
		expect(live('threads.contained_locked')).toEqual([
			"\t'threads.contained_locked': { de: 'Privat-Modus bleibt an. Dieser Chat hat Daten über eine Shop-Verbindung gelesen und kann deshalb nur noch lesen und erklären. Für alles andere starte einen neuen Chat.', en: 'Private mode stays on. This chat read data through a store connection, so it can only read and explain now. Start a new chat for anything else.' },",
		]);
		expect(live('threads.contained_badge')).toEqual([
			"\t'threads.contained_badge': { de: 'Nur lesen wegen Shop-Daten', en: 'Read-only because of store data' },",
		]);
		expect(live('threads.error_contained')).toEqual([
			"\t'threads.error_contained': { de: 'Der Privat-Modus bleibt an, weil dieser Chat Daten über eine Shop-Verbindung gelesen hat. Für alles andere starte einen neuen Chat.', en: 'Private mode stays on because this chat read data through a store connection. Start a new chat for anything else.' },",
		]);
	});
});
