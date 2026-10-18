import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	bulkAtProbe, bulkCanUndo, bulkHostOf, bulkLabel, bulkStep, bulkSystemName, bulkValueText, bulkWaitsForStart, bulkWriting,
	type BulkI18n, type BulkRunDetailData,
} from './bulk-runs.js';
import { BULK_UNMEASURED_CONFIRMATION, BULK_UNMEASURED_NOTE } from '../../../../../src/core/bulk-write-forms.js';

const TABLE: Record<string, string> = {
	'bulk.label': '{n} Ziele · {target}',
	'bulk.label_undo': 'Rücknahme · {n} Ziele · {target}',
	'bulk.system.data_store': 'Datenspeicher',
};
const i18n: BulkI18n = {
	t: (k) => TABLE[k] ?? k,
	tf: (k, vars) => Object.entries(vars).reduce((s, [name, v]) => s.replace(`{${name}}`, v), TABLE[k] ?? k),
};
const probeState = (o: Partial<Pick<BulkRunDetailData, 'probe' | 'haltReason' | 'phase'>>): Pick<BulkRunDetailData, 'probe' | 'haltReason' | 'phase'> =>
	({ probe: null, haltReason: null, phase: 'previewed', ...o });

describe('bulk run helpers', () => {
	it('names a run by its size and where it writes, an undo as such', () => {
		expect(bulkLabel({ kind: 'apply', total: 220, targetSystem: 'http:shop.example.invalid' }, i18n)).toBe('220 Ziele · shop.example.invalid');
		expect(bulkLabel({ kind: 'undo', total: 14, targetSystem: 'data_store' }, i18n)).toBe('Rücknahme · 14 Ziele · Datenspeicher');
	});

	it('shows the host of an external run and the raw name of a system it has no word for', () => {
		expect(bulkHostOf('http:api.bexio.com')).toBe('api.bexio.com');
		expect(bulkHostOf('data_store')).toBeNull();
		expect(bulkSystemName('memory', i18n)).toBe('memory');
	});

	it('counts the targets a run writes, not the unchanged or invalid ones', () => {
		expect(bulkWriting({ changes: { update: 3, create: 2, delete: 1, unchanged: 7, invalid: 5 } })).toBe(6);
	});

	it('stands at the probe only with a probe target and a halt', () => {
		const probe = { key: 'https://api.bexio.com/2.0/contact/1', fields: ['name_1'] };
		expect(bulkAtProbe(probeState({ probe, haltReason: 'x', phase: 'writing' }))).toBe(true);
		expect(bulkAtProbe(probeState({ probe, haltReason: null, phase: 'writing' }))).toBe(false);
		expect(bulkAtProbe(probeState({ probe: null, haltReason: 'x', phase: 'writing' }))).toBe(false);
		expect(bulkAtProbe(probeState({ probe, haltReason: 'x', phase: 'previewed' }))).toBe(false);
		// A run that finished has nothing left to write after its probe.
		expect(bulkAtProbe(probeState({ probe, haltReason: 'x', phase: 'done' }))).toBe(false);
	});

	it('waits for a start only on the halts that wait for one, not on a failed read', () => {
		expect(bulkWaitsForStart({ phase: 'planned', haltKey: 'awaitingStart' })).toBe(true);
		expect(bulkWaitsForStart({ phase: 'planned', haltKey: 'listed' })).toBe(true);
		expect(bulkWaitsForStart({ phase: 'planned', haltKey: 'listUnreadable' })).toBe(false);
		expect(bulkWaitsForStart({ phase: 'writing', haltKey: 'awaitingStart' })).toBe(false);
	});

	it('offers an undo for what an undo would take back, a failed external write included', () => {
		const stopped = { kind: 'apply' as const, phase: 'writing' as const, haltReason: 'x', probe: null };
		// Nothing applied, but a write that went out and failed may have landed.
		expect(bulkCanUndo({ ...stopped, undoable: 1 })).toBe(true);
		expect(bulkCanUndo({ ...stopped, undoable: 0 })).toBe(false);
		expect(bulkCanUndo({ ...stopped, phase: 'writing', haltReason: null, undoable: 1 })).toBe(false);
		expect(bulkCanUndo({ ...stopped, phase: 'done', haltReason: null, undoable: 1 })).toBe(true);
		expect(bulkCanUndo({ ...stopped, phase: 'aborted', haltReason: null, undoable: 1 })).toBe(true);
		expect(bulkCanUndo({ ...stopped, kind: 'undo', undoable: 1 })).toBe(false);
		// Approved but not started: nothing is stopped yet, and the engine refuses to plan an undo.
		expect(bulkCanUndo({ ...stopped, phase: 'approved', undoable: 1 })).toBe(false);
		// At its probe the run has its own way back.
		expect(bulkCanUndo({ ...stopped, probe: { key: 'k', fields: [] }, undoable: 1 })).toBe(false);
	});

	it('places a run on its step', () => {
		const probe = { key: 'k', fields: [] };
		expect(bulkStep(probeState({ phase: 'planned' }))).toBe(0);
		expect(bulkStep(probeState({ phase: 'previewed' }))).toBe(2);
		expect(bulkStep(probeState({ phase: 'writing', probe, haltReason: 'x' }))).toBe(3);
		expect(bulkStep(probeState({ phase: 'writing' }))).toBe(4);
		expect(bulkStep(probeState({ phase: 'done' }))).toBe(5);
	});

	it('shows text as it is and anything else as JSON; empty as nothing', () => {
		expect(bulkValueText('a')).toBe('a');
		expect(bulkValueText(3)).toBe('3');
		expect(bulkValueText({ a: 1 })).toBe('{"a":1}');
		expect(bulkValueText('')).toBe('');
		expect(bulkValueText(null)).toBe('');
	});
});

// The note on an unchecked kind of change and its confirmation are approved customer texts:
// German word for word, English the engine's own constants. Compared as whole
// lines of the table — i18n is a Svelte module and cannot be imported here.
describe('the approved unchecked-change texts', () => {
	const source = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf8');
	const line = (key: string): string => {
		const hits = source.split('\n').filter((l) => l.trimStart().startsWith(`'${key}':`));
		expect(hits, key).toHaveLength(1);
		return hits[0]!.trim();
	};
	const entry = (key: string, de: string, en: string): string => `'${key}': { de: ${JSON.stringify(de).replace(/^"|"$/g, "'")}, en: ${JSON.stringify(en).replace(/^"|"$/g, "'")} },`;

	it('holds the note', () => {
		expect(line('bulk.approve.unmeasured_note')).toBe(entry('bulk.approve.unmeasured_note',
			'lynox hat diese Art Änderung bei diesem Anbieter nicht geprüft. Beim Anbieter kann sie zusätzlich etwas auslösen, etwa E-Mails an deine Kunden, eine Zahlung oder eine Rechnung. Deshalb schreibt lynox zuerst nur ein Ziel. Schau es dir dort an, bevor du den Rest freigibst.',
			BULK_UNMEASURED_NOTE));
	});

	it('holds the confirmation', () => {
		expect(line('bulk.approve.unmeasured_confirm')).toBe(entry('bulk.approve.unmeasured_confirm',
			'Ich weiss, dass lynox diese Art Änderung nicht geprüft hat, und gebe sie trotzdem frei.',
			BULK_UNMEASURED_CONFIRMATION));
	});
});
