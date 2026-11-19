import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runContainedBadgeKey, runContainedNoteKeys, runContainedState } from './run-contained-text.js';

describe('what the workflow-run view says about a run from a chat that only reads', () => {
	it('reads the state only from `contained: true`, and the unknown only from the values the engine sends', () => {
		expect(runContainedState({})).toBeNull();
		expect(runContainedState({ contained: false })).toBeNull();
		expect(runContainedState({ contained: 'true' })).toBeNull();
		expect(runContainedState({ contained: true })).toEqual({ unknown: null });
		expect(runContainedState({ contained: true, contained_unknown: 'provisioned' })).toEqual({ unknown: 'provisioned' });
		expect(runContainedState({ contained: true, contained_unknown: 'other' })).toEqual({ unknown: null });
	});

	it('a failed check never shows the recorded text, and names the way that fits the instance', () => {
		expect(runContainedBadgeKey(null)).toBe('workflow.run_contained_badge');
		expect(runContainedBadgeKey('provisioned')).toBe('workflow.run_contained_badge_unknown');
		expect(runContainedNoteKeys(null)).toEqual(['workflow.run_contained_note']);
		expect(runContainedNoteKeys('provisioned')).toEqual(['workflow.run_contained_note_unknown', 'contained.unknown_way_support']);
		expect(runContainedNoteKeys('self-hosted')).toEqual(['workflow.run_contained_note_unknown', 'contained.unknown_way_logs']);
	});

	it('holds the wording in both languages', () => {
		const source = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8');
		const entry = (key: string): string => {
			const lines = source.split('\n').filter((l) => l.trimStart().startsWith(`'${key}':`));
			expect(lines, key).toHaveLength(1);
			return lines[0]!;
		};
		const texts: Array<[string, string, string]> = [
			['workflow.run_contained_badge', 'Shop-Daten', 'Shop data'],
			['workflow.run_contained_badge_unknown', 'Shop-Daten: Prüfung gestört', 'Shop data: check failed'],
			['workflow.run_contained_note', 'Dieser Lauf wurde aus einem Chat gestartet, der Daten über eine Shop-Verbindung gelesen hat. Seine Ausgaben können Shop-Daten enthalten. lynox übernimmt sie deshalb nicht ins Gedächtnis, und ein anderer Chat, der sie liest, kann danach ebenfalls nur noch lesen.', 'This run was started from a chat that read data through a shop connection. Its outputs may contain shop data, so lynox does not carry them into its memory, and another chat that reads them can then only read as well.'],
			['workflow.run_contained_note_unknown', 'Dieser Lauf wurde aus einem Chat gestartet, bei dem lynox gerade nicht prüfen kann, ob er Shop-Daten gelesen hat. lynox behandelt die Ausgaben deshalb so, als enthielten sie welche: Sie kommen nicht ins Gedächtnis, und ein anderer Chat, der sie liest, kann danach ebenfalls nur noch lesen. Das ist eine Störung der Instanz.', 'This run was started from a chat for which lynox cannot check right now whether it read shop data. lynox therefore treats its outputs as if they did: they do not go into its memory, and another chat that reads them can then only read as well. This is a fault of the instance.'],
		];
		for (const [key, de, en] of texts) {
			const line = entry(key);
			expect(line, key).toContain(`de: '${de}'`);
			expect(line, key).toContain(`en: '${en}'`);
		}
	});
});
