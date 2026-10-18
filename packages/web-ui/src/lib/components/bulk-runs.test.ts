import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	bulkAtProbe, bulkCanUndo, bulkCostCap, bulkHostOf, bulkJudgeProviderName, bulkLabel, bulkStartKind, bulkStep, bulkVisibleText, bulkSystemName, bulkValueText, bulkWaitsForStart, bulkWriting,
	type BulkI18n, type BulkRunDetailData,
} from './bulk-runs.js';
import { BULK_UNMEASURED_CONFIRMATION, BULK_UNMEASURED_NOTE } from '../../../../../src/core/bulk-write-forms.js';
import { BULK_LIST_NOTE } from '../../../../../src/core/bulk-list.js';

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

	it('starts a waiting run the way it waits: its list first, then its judging or its read', () => {
		const waiting = { phase: 'planned' as const, haltKey: 'awaitingStart', listFirstPage: null, judge: null, judgeServedBy: null, judgeOwnKey: false };
		const judge = { tier: 'fast', unjudged: 3 };
		const servedBy = { provider: 'mistral', label: 'Mistral Medium 3.5' };
		expect(bulkStartKind(waiting)).toBe('read');
		// A list's first start reads only the list, judged or not.
		expect(bulkStartKind({ ...waiting, listFirstPage: 'https://shop.example.invalid/items?page=1', judge, judgeServedBy: servedBy })).toBe('list');
		expect(bulkStartKind({ ...waiting, haltKey: 'listed', judge, judgeServedBy: servedBy })).toBe('judge');
		expect(bulkStartKind({ ...waiting, haltKey: 'listed' })).toBe('read');
		// No model can judge it now: no start offered — not even the read of its list.
		expect(bulkStartKind({ ...waiting, judge })).toBe('no_judge');
		expect(bulkStartKind({ ...waiting, judge, listFirstPage: 'https://shop.example.invalid/items?page=1' })).toBe('no_judge');
		// An instance with its own model key starts no judged run, its list included; a plain run starts.
		expect(bulkStartKind({ ...waiting, judge, judgeServedBy: servedBy, judgeOwnKey: true })).toBe('judge_own_key');
		expect(bulkStartKind({ ...waiting, judge, judgeServedBy: servedBy, judgeOwnKey: true, listFirstPage: 'https://shop.example.invalid/items?page=1' })).toBe('judge_own_key');
		expect(bulkStartKind({ ...waiting, judgeOwnKey: true })).toBe('read');
		// Halted on a failure, or not planned: not a start.
		expect(bulkStartKind({ ...waiting, haltKey: 'unavailable' })).toBeNull();
		expect(bulkStartKind({ ...waiting, phase: 'previewed' })).toBeNull();
	});

	it('takes a spend limit above zero to the cent, exactly as typed', () => {
		expect(bulkCostCap('5')).toBe(5);
		expect(bulkCostCap('0.30')).toBe(0.3);
		expect(bulkCostCap('2,50')).toBe(2.5);
		expect(bulkCostCap(' 12.5 ')).toBe(12.5);
		for (const bad of ['', '0', '0.00', '-1', '1.005', '1e2', 'abc', '1.', '.5', null, undefined]) expect(bulkCostCap(bad), String(bad)).toBeNull();
	});

	it('shows every hidden character of a text the run acts on as its code point, and keeps what a language needs', () => {
		const tag = String.fromCodePoint(0xe0041);
		expect(bulkVisibleText(`Kürze den Titel${tag}`)).toBe('Kürze den Titel⟨U+E0041⟩');
		expect(bulkVisibleText('a\u202Eb\u200Bc\u0007d')).toBe('a⟨U+202E⟩b⟨U+200B⟩c⟨U+0007⟩d');
		// Every class in the set, one witness each.
		for (const [hidden, code] of [['\u000B', '000B'], ['\u000C', '000C'], ['\u000E', '000E'], ['\u001F', '001F'], ['\u3164', '3164'], ['\u0085', '0085'], ['\uFEFF', 'FEFF'], ['\u2066', '2066'], ['\u2069', '2069'], ['\u2060', '2060'], ['\uFFF9', 'FFF9'], ['\u180E', '180E'], ['\u2028', '2028'], [String.fromCodePoint(0xe0100), 'E0100'], [String.fromCodePoint(0xe01ef), 'E01EF'], [String.fromCodePoint(0xe007f), 'E007F']] as const) {
			expect(bulkVisibleText(`x${hidden}y`), code).toBe(`x⟨U+${code}⟩y`);
		}
		// Line breaks (also CRLF), tabs, ZWJ in an emoji, ZWNJ in Persian, the direction marks, a soft
		// hyphen and an emoji's variation selector are content.
		for (const kept of ['zwei\nZeilen\tmit Tab', 'Zeile\r\nZeile', '👨\u200D👩\u200D👧', 'می\u200Cروم', 'abc\u200Fdef', 'عربي\u061Cنص', 'Massen\u00ADlauf', '❤\uFE0F']) expect(bulkVisibleText(kept)).toBe(kept);
		// A preview value carries them visibly too, a structured one included.
		expect(bulkValueText(`neu${tag}`)).toBe('neu⟨U+E0041⟩');
		expect(bulkValueText({ status: `aktiv${tag}` })).toBe('{"status":"aktiv⟨U+E0041⟩"}');
	});

	it('names the provider that serves a judge call', () => {
		expect(bulkJudgeProviderName('vertex')).toBe('Google Vertex');
		expect(bulkJudgeProviderName('fireworks')).toBe('Fireworks');
		expect(bulkJudgeProviderName('somewhere')).toBe('somewhere');
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

	it('holds the note on a list read page by page', () => {
		expect(line('bulk.start.list_note')).toBe(entry('bulk.start.list_note',
			'Die Liste wurde Seite für Seite gelesen, nicht auf einen Schlag. Kam beim Anbieter während des Lesens etwas dazu, fiel etwas weg oder wurde umsortiert, kann es bei den Zielen fehlen oder nur einmal stehen, obwohl es sich verschoben hat.',
			BULK_LIST_NOTE));
	});

	it('holds the confirmation', () => {
		expect(line('bulk.approve.unmeasured_confirm')).toBe(entry('bulk.approve.unmeasured_confirm',
			'Ich weiss, dass lynox diese Art Änderung nicht geprüft hat, und gebe sie trotzdem frei.',
			BULK_UNMEASURED_CONFIRMATION));
	});
});

// Every value the run's pages show that a provider, the planner or a contact supplied passes
// through bulkVisibleText (or bulkValueText, which uses it): a hidden character in it must be
// visible to the owner who acts on it. Checked over the templates rather than per site, so a new
// site that forgets it fails here. Engine-authored text (halt reasons, the host from a parsed URL,
// catalog labels) is not in the list.
describe('the bulk pages show supplied text only through bulkVisibleText', () => {
	const SUPPLIED = /target\.key|target\.error|target\.sentUnchanged|\bf\.field\b|\bline\b|\bfield\b|\bc\.key\b|run\.probe\.key|run\.probe\.fields|run\.listFirstPage|run\.judgeRule\.rule|merge\.dupName|merge\.canonicalName/g;
	const unwrapped = (svelte: string): string[] => {
		const markup = svelte.split('</script>').slice(1).join('</script>');
		// Every top-level {…} of the markup, braces counted, so an object literal inside a call
		// stays part of its expression. Blocks ({#…}, {:…}, {/…}, {@…}) are not displays.
		const exprs: string[] = [];
		let depth = 0;
		let start = -1;
		for (let i = 0; i < markup.length; i++) {
			if (markup[i] === '{') { if (depth === 0) start = i + 1; depth++; }
			else if (markup[i] === '}' && depth > 0) { depth--; if (depth === 0) exprs.push(markup.slice(start, i)); }
		}
		const out: string[] = [];
		for (const expr of exprs.filter((e) => !/^[#:/@]/.test(e))) {
			for (const hit of expr.matchAll(SUPPLIED)) {
				const before = expr.slice(0, hit.index);
				const after = expr.slice(hit.index! + hit[0].length);
				if (/(bulkVisibleText|bulkValueText)\($/.test(before)) continue;
				// A key of an object literal names a placeholder; it shows nothing.
				if (/^\s*:(?!:)/.test(after) && /[{,]\s*$/.test(before)) continue;
				// A test of the value, not a display of it: a length or a comparison.
				if (/^\s*\.length\b|^\s*(===|!==)/.test(after)) continue;
				out.push(expr.trim());
			}
		}
		return out;
	};
	const read = (name: string): string => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');

	it('finds no supplied value shown raw', () => {
		expect(unwrapped(read('BulkRunDetail.svelte'))).toEqual([]);
		expect(unwrapped(read('BulkRunsView.svelte'))).toEqual([]);
	});

	it('would find one (the detector is not blind)', () => {
		const raw = '<script></script><p>{run.probe.key}</p><p>{tf(\'k\', { dup: merge.dupName })}</p><p>{bulkVisibleText(target.key)}</p><p>{run.probe.fields.length > 0 ? 1 : 0}</p>';
		expect(unwrapped(raw)).toEqual(['run.probe.key', "tf('k', { dup: merge.dupName })"]);
		// A placeholder named like a supplied value is not one.
		expect(unwrapped("<script></script><p>{tf('k', { field: bulkVisibleText(f.field) })}</p>")).toEqual([]);
	});
});
