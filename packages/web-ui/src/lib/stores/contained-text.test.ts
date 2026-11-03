import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { containedTextKeys, readContainedUnknown, type ContainedSlot } from './contained-text.js';

const SLOTS: ContainedSlot[] = ['locked', 'badge', 'bar', 'error'];

describe('what the page says about a chat that only reads', () => {
	it('a known record: the text that says the chat read store data', () => {
		expect(SLOTS.map((s) => containedTextKeys(s, null))).toEqual([
			['threads.contained_locked'], ['threads.contained_badge'], ['contained.bar'], ['threads.error_contained'],
		]);
	});

	it('a failed check: never the text that says the chat read store data, and where to look', () => {
		for (const s of SLOTS) {
			for (const unknown of ['provisioned', 'self-hosted'] as const) {
				const keys = containedTextKeys(s, unknown);
				expect(keys, `${s} ${unknown}`).not.toContain(containedTextKeys(s, null)[0]);
				expect(keys[0], `${s} ${unknown}`).toMatch(/_unknown$/);
			}
		}
		for (const s of ['locked', 'bar', 'error'] as const) {
			expect(containedTextKeys(s, 'provisioned')[1]).toBe('contained.unknown_way_support');
			expect(containedTextKeys(s, 'self-hosted')[1]).toBe('contained.unknown_way_logs');
		}
		// The badge is too short for the way.
		expect(containedTextKeys('badge', 'provisioned')).toEqual(['threads.contained_badge_unknown']);
	});

	it('reads only the values the engine sends', () => {
		expect(readContainedUnknown('provisioned')).toBe('provisioned');
		expect(readContainedUnknown('self-hosted')).toBe('self-hosted');
		for (const v of [undefined, null, true, '', 'Provisioned', 'managed']) expect(readContainedUnknown(v)).toBeNull();
	});

	it('holds the wording in both languages', () => {
		const source = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8');
		const entry = (key: string): string => {
			const lines = source.split('\n').filter((l) => l.trimStart().startsWith(`'${key}':`));
			expect(lines, key).toHaveLength(1);
			return lines[0]!;
		};
		const texts: Array<[string, string, string]> = [
			['threads.contained_locked_unknown', 'Privat-Modus bleibt an. lynox kann gerade nicht prüfen, ob dieser Chat Daten über eine Shop-Verbindung gelesen hat, und behandelt ihn deshalb so, als hätte er es: Er kann nur lesen und erklären. Das betrifft gerade alle Chats und ist eine Störung der Instanz.', 'Private mode stays on. lynox cannot check right now whether this chat read data through a shop connection, so it treats it as if it had: it can only read and explain. This affects all chats right now and is a fault of the instance.'],
			['threads.contained_badge_unknown', 'Nur lesen: Prüfung gestört', 'Read only: check failed'],
			['contained.bar_unknown', 'Nur lesen: lynox kann gerade nicht prüfen, ob dieser Chat Shop-Daten gelesen hat. Das betrifft alle Chats.', 'Read only: lynox cannot check right now whether this chat read shop data. This affects all chats.'],
			['threads.error_contained_unknown', 'Der Privat-Modus bleibt an, weil lynox gerade nicht prüfen kann, ob dieser Chat Shop-Daten gelesen hat. Ein neuer Chat hilft nicht, denn das betrifft gerade alle Chats.', 'Private mode stays on because lynox cannot check right now whether this chat read shop data. A new chat does not help, because this affects all chats right now.'],
			['contained.unknown_way_support', 'Schreib an support@lynox.ai.', 'Write to support@lynox.ai.'],
			['contained.unknown_way_logs', 'Sieh in den Logs der Instanz nach, warum ihre Datenbank nicht lesbar ist.', "Check the instance\\'s logs for why its database cannot be read."],
		];
		for (const [key, de, en] of texts) {
			const line = entry(key);
			expect(line, key).toContain(`de: '${de}'`);
			expect(line, key).toContain(`en: '${en}'`);
		}
	});
});
