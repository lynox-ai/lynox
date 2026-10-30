import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	bulkAtProbe, bulkCanUndo, bulkCostCap, bulkHaltCause, bulkHaltHeadKey, bulkHaltSuffixKey, bulkHaltText, bulkHostOf, bulkJudgeProviderName, bulkLabel, bulkManagedOf, bulkMergeAnswer, bulkMergeState, bulkMergeTakeable, bulkRestartCap, bulkRestartKind, bulkSentUnknownText, bulkResumeKind, bulkResumeMax, bulkResumeText, bulkRollbackIncomplete, bulkRollbackLeft, bulkRollbackText, bulkStartButtonKey, bulkStartKind, bulkStateText, bulkStep, bulkSupportMailto, bulkUsd, bulkVisibleText, bulkSystemName, bulkValueText, bulkWaitsForStart, bulkWriting,
	type BulkI18n, type BulkRunDetailData,
	bulkFieldLabelKey, bulkFieldNamesText, bulkIsShopifyHost, bulkInvalidText, bulkSkippedHead,
} from './bulk-runs.js';
import { BULK_UNMEASURED_CONFIRMATION, BULK_UNMEASURED_NOTE } from '../../../../../src/core/bulk-write-forms.js';
import { BULK_LIST_NOTE } from '../../../../../src/core/bulk-list.js';
import { BULK_HALT_REASONS } from '../../../../../src/core/bulk-ledger.js';
import { MERGE_REFUSAL_CODES } from '../../../../../src/core/subject-merge-runner.js';

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
		const stopped = { kind: 'apply' as const, phase: 'writing' as const, haltReason: 'x', probe: null, atomic: false };
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
		// An atomic run is taken back whole or not at all: only once it finished. One that aborted
		// rolled back what it could, and the engine refuses its undo (`atomic_partial`).
		expect(bulkCanUndo({ ...stopped, atomic: true, phase: 'aborted', undoable: 2 })).toBe(false);
		expect(bulkCanUndo({ ...stopped, atomic: true, phase: 'writing', undoable: 2 })).toBe(false);
		expect(bulkCanUndo({ ...stopped, atomic: true, phase: 'done', haltReason: null, undoable: 2 })).toBe(true);
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
describe('a Shopify run\'s field names and note', () => {
	it('names the four fields of a store readably, and any other field or host by its own name', () => {
		expect(bulkFieldLabelKey('acme.myshopify.com', 'seo_title')).toBe('bulk.field.shopify.seo_title');
		expect(bulkFieldLabelKey('acme.myshopify.com', 'descriptionHtml')).toBe('bulk.field.shopify.descriptionHtml');
		expect(bulkFieldLabelKey('acme.myshopify.com', 'vendor')).toBeNull();
		expect(bulkFieldLabelKey('acme.myshopify.com', 'constructor')).toBeNull();
		expect(bulkFieldLabelKey('shop.example.com', 'title')).toBeNull();
		expect(bulkFieldLabelKey(null, 'title')).toBeNull();
	});

	it('joins readable names, and shows a field of its own name with its hidden characters', () => {
		const label = (key: string): string => `<${key}>`;
		expect(bulkFieldNamesText('acme.myshopify.com', ['title', 'seo_title'], label)).toBe('<bulk.field.shopify.title>, <bulk.field.shopify.seo_title>');
		expect(bulkFieldNamesText('shop.example.com', ['ti\u200btle'], label)).toBe('ti⟨U+200B⟩tle');
	});

	it('knows a store host exactly, not by a suffix', () => {
		expect(bulkIsShopifyHost('acme.myshopify.com')).toBe(true);
		for (const host of ['myshopify.com', 'a.b.myshopify.com', 'acme.myshopify.com.evil.io', 'admin.shopify.com', null]) expect(bulkIsShopifyHost(host), String(host)).toBe(false);
	});
});

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

	it('holds the Shopify note and the readable field names (ux 2026-10-26)', () => {
		expect(line('bulk.approve.shopify_visible')).toBe(entry('bulk.approve.shopify_visible',
			'Bei veröffentlichten Produkten sind Titel und SEO-Texte sofort in deinem Shop sichtbar, sobald lynox sie schreibt.',
			'For published products, titles and SEO texts are visible in your shop as soon as lynox writes them.'));
		for (const [key, de, en] of [['title', 'Titel', 'Title'], ['descriptionHtml', 'Beschreibung', 'Description'], ['seo_title', 'SEO-Titel', 'SEO title'], ['seo_description', 'SEO-Beschreibung', 'SEO description']] as const) {
			expect(line(`bulk.field.shopify.${key}`)).toBe(entry(`bulk.field.shopify.${key}`, de, en));
		}
	});

	it('holds the reason beside a disabled approve, tied to the button for a screen reader (ux 2026-10-26)', () => {
		expect(line('bulk.approve.confirm_first')).toBe(entry('bulk.approve.confirm_first',
			'Setz zuerst das Häkchen oben, dann kannst du freigeben.', 'Tick the box above first, then you can approve.'));
		const page = readFileSync(fileURLToPath(new URL('./BulkRunDetail.svelte', import.meta.url)), 'utf8');
		expect(page).toContain(`aria-describedby={skipped.nothing ? 'bulk-approve-nothing' : run.writeForm === 'unmeasured' && !unmeasuredOk ? 'bulk-approve-confirm-first' : undefined}`);
		expect(page).toContain(`<p id="bulk-approve-confirm-first" `);
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
				// Its second argument goes through bulkVisibleText inside (tested below).
				if (/bulkFieldNamesText\(host, $/.test(before)) continue;
				// A reason is a lookup key; one without a sentence is shown through bulkVisibleText (tested).
				if (/bulkInvalidText\($/.test(before)) continue;
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

// A run that halted goes on from its page, with its own sentence for each halt: a planned run
// restarts, an approved one writes on. Read from the i18n source, both languages, so a key
// the page asks for and the table lacks fails here instead of showing no sentence.
describe('going on from a run that halted', () => {
	const source = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf8');
	const ENTRY = /^\s*'([^']+)': \{ de: '((?:[^'\\]|\\.)*)', en: '((?:[^'\\]|\\.)*)' \},$/;
	const de: Record<string, string> = {};
	const en: Record<string, string> = {};
	for (const l of source.split('\n')) {
		const m = ENTRY.exec(l);
		if (m) { de[m[1]!] = m[2]!.replace(/\\'/g, "'"); en[m[1]!] = m[3]!.replace(/\\'/g, "'"); }
	}
	const from = (table: Record<string, string>): BulkI18n => ({
		t: (k) => table[k] ?? k,
		tf: (k, vars) => Object.entries(vars).reduce((s, [name, v]) => s.split(`{${name}}`).join(v), table[k] ?? k),
	});
	const DE = from({ ...de, 'bulk.system.data_store': 'Datenspeicher' });
	const EN = from(en);

	// Over the engine's own set, not a list: every halt an atomic run ends in has its sentence.
	const ATOMIC = Object.keys(BULK_HALT_REASONS).filter((k) => k.startsWith('atomic'));

	it('says in both languages why an atomic run rolled back, for every reason it can roll back with', () => {
		expect(ATOMIC.length).toBe(6);
		for (const haltKey of ATOMIC) {
			for (const [lang, i] of [['de', DE], ['en', EN]] as const) {
				const said = bulkRollbackText({ phase: 'aborted', haltKey }, i);
				expect(said, `${lang} ${haltKey}`).not.toBeNull();
				expect(said!.cause, `${lang} ${haltKey}`).not.toMatch(/bulk\.|\{/);
				expect(said!.cause, `${lang} ${haltKey}`).not.toBe(BULK_HALT_REASONS[haltKey as keyof typeof BULK_HALT_REASONS]);
				expect(said!.incomplete, haltKey).toBe(haltKey.endsWith('Incomplete'));
				// A run out of time says so first, or an incomplete rollback reads like a failed write.
				const lead = lang === 'de' ? 'Die Zeit für diesen Lauf ist abgelaufen. ' : 'The time for this run ran out. ';
				expect(said!.cause.startsWith(lead), `${lang} ${haltKey}`).toBe(haltKey.startsWith('atomicTime'));
				// No rolled-back run can be started again, only planned again: none promises a restart.
				expect(said!.cause, `${lang} ${haltKey}`).not.toMatch(/neu starten|start the run again/);
			}
		}
		// The words decided for the page, one of each kind.
		expect(bulkRollbackText({ phase: 'aborted', haltKey: 'atomicRollbackIncomplete' }, DE)!.cause)
			.toBe('lynox konnte nicht alles zurücknehmen. Bei den markierten Zielen hat lynox die Änderung nicht zurückgenommen. Prüf sie und korrigiere sie falls nötig von Hand.');
		expect(bulkRollbackText({ phase: 'aborted', haltKey: 'atomicTimeRollbackIncomplete' }, EN)!.cause)
			.toBe('The time for this run ran out. lynox could not take everything back. lynox did not take the change back on the marked targets. Check them and correct them by hand if needed.');
		expect(bulkRollbackText({ phase: 'aborted', haltKey: 'atomicTimeRolledBack' }, DE)!.cause.startsWith('Die Zeit für diesen Lauf ist abgelaufen. ')).toBe(true);
		expect(bulkRollbackText({ phase: 'aborted', haltKey: 'atomicStoppedRolledBack' }, EN)!.cause)
			.toBe('The run was stopped. Because it is meant to apply completely or not at all, lynox took everything back. Nothing is changed.');
		// Any other halt, or a run that did not abort, keeps its own sentence or the engine's reason.
		expect(bulkRollbackText({ phase: 'aborted', haltKey: 'failureRate' }, DE)).toBeNull();
		expect(bulkRollbackText({ phase: 'writing', haltKey: 'atomicRolledBack' }, DE)).toBeNull();
		expect(bulkRollbackText({ phase: 'aborted', haltKey: null }, DE)).toBeNull();
	});

	it('offers no way on from a run that rolled back', () => {
		for (const haltKey of ATOMIC) {
			const run = { phase: 'aborted' as const, haltKey, probe: null, haltReason: 'x', probeConfirmed: true, maxTargets: null, changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 } };
			expect(bulkResumeKind(run), haltKey).toBeNull();
			expect(bulkRestartKind({ ...run, listFirstPage: null, judge: null, judgeServedBy: null, judgeOwnKey: false }), haltKey).toBeNull();
			expect(bulkCanUndo({ ...run, kind: 'apply', undoable: 2, atomic: true }), haltKey).toBe(false);
		}
	});

	it('marks exactly the targets an incomplete rollback left as they were', () => {
		const left = { phase: 'aborted' as const, haltKey: 'atomicRollbackIncomplete' };
		expect(bulkRollbackLeft(left, { written: true, undone: false })).toBe(true);
		// Taken back, never written by the run, or sent by an engine that does not say: not marked.
		expect(bulkRollbackLeft(left, { written: true, undone: true })).toBe(false);
		expect(bulkRollbackLeft(left, { written: false, undone: false })).toBe(false);
		expect(bulkRollbackLeft(left, {})).toBe(false);
		for (const haltKey of ATOMIC.filter((k) => k.endsWith('Incomplete'))) expect(bulkRollbackLeft({ phase: 'aborted', haltKey }, { written: true, undone: false }), haltKey).toBe(true);
		// A rollback that completed leaves nothing to mark, and neither does any other halt.
		for (const haltKey of ['atomicRolledBack', 'atomicStoppedRolledBack', 'atomicTimeRolledBack', 'failureRate']) {
			expect(bulkRollbackLeft({ phase: 'aborted', haltKey }, { written: true, undone: false }), haltKey).toBe(false);
		}
		expect(bulkRollbackLeft({ phase: 'writing', haltKey: 'atomicRollbackIncomplete' }, { written: true, undone: false })).toBe(false);
		expect(ATOMIC.filter((haltKey) => bulkRollbackIncomplete({ phase: 'aborted', haltKey }))).toEqual(ATOMIC.filter((k) => k.endsWith('Incomplete')));
	});

	it('says the same about targets an earlier send left unclear on every halt, a finished run and every size', () => {
		const one = 'Bei einem Ziel ist offen, ob die Änderung beim Anbieter angekommen ist. Die Sendung blieb ohne klare Antwort. lynox sendet sie nicht noch einmal, sonst könnte die Änderung doppelt ankommen. Sieh beim Anbieter nach. Fehlt die Änderung dort, bitte lynox im Chat, den Lauf neu zu planen.';
		const states = [
			{ phase: 'writing', haltKey: 'failureRate', total: 5 }, { phase: 'writing', haltKey: 'failureRate', total: 60 },
			{ phase: 'writing', haltKey: 'consecutiveFailures', total: 20 }, { phase: 'writing', haltKey: 'maxTargets', total: 19 },
			{ phase: 'writing', haltKey: 'timeBudget', total: 200 }, { phase: 'done', haltKey: null, total: 5 },
		];
		for (const s of states) {
			expect(bulkSentUnknownText({ ...s, sentUnknown: 1 } as Pick<BulkRunDetailData, 'sentUnknown'>, DE), JSON.stringify(s)).toBe(one);
			expect(bulkSentUnknownText({ ...s, sentUnknown: 3 } as Pick<BulkRunDetailData, 'sentUnknown'>, EN), JSON.stringify(s))
				.toBe('For 3 targets it is unclear whether the change reached the provider. The sends got no clear answer. lynox does not send them again, or changes could arrive twice. Check at the provider. If a change is missing there, ask lynox in the chat to plan the run again.');
			expect(bulkSentUnknownText({ ...s, sentUnknown: 0 } as Pick<BulkRunDetailData, 'sentUnknown'>, DE), JSON.stringify(s)).toBeNull();
		}
	});

	const AS_IS = ['unavailable', 'timeBudget', 'consecutiveFailures', 'stoppedByOwner', 'listUnreadable', 'credential', 'unauthorized', 'blocked', 'creditRefused', 'spendLimit', 'judgeModel', 'unrecorded', 'listReadFailed', 'shopInactive'];
	const NONE = ['contract', 'listFormWithdrawn', 'listNotAList', 'listTooLarge', 'listNoProgress', 'listOrder', 'formCost', 'shopifyReadOff'];
	const base = { phase: 'planned' as const, listFirstPage: null, judge: null, judgeServedBy: null, judgeOwnKey: false };
	const judged = { judge: { tier: 'fast', unjudged: 3 }, judgeServedBy: { provider: 'mistral', label: 'Mistral Medium' } } as unknown as Pick<BulkRunDetailData, 'judge' | 'judgeServedBy'>;

	it('moves a run on by what it does next, and refuses where a restart would halt again', () => {
		for (const haltKey of AS_IS) expect(bulkRestartKind({ ...base, haltKey }), haltKey).toBe('read');
		for (const haltKey of NONE) expect(bulkRestartKind({ ...base, haltKey }), haltKey).toBe('none');
		expect(bulkRestartKind({ ...base, haltKey: 'listUnreadable', listFirstPage: 'https://shop.example.invalid/items?page=1' })).toBe('list');
		expect(bulkRestartKind({ ...base, ...judged, haltKey: 'unavailable' })).toBe('judge');
		expect(bulkRestartKind({ ...base, ...judged, haltKey: 'costCap' })).toBe('judge_cap');
		// A judged run whose list is still read reads its list on first.
		expect(bulkRestartKind({ ...base, ...judged, haltKey: 'costCap', listFirstPage: 'https://shop.example.invalid/items?page=1' })).toBe('list');
		expect(bulkRestartKind({ ...base, ...judged, haltKey: 'unavailable', judgeServedBy: null })).toBe('no_judge');
		expect(bulkRestartKind({ ...base, ...judged, haltKey: 'unavailable', judgeOwnKey: true })).toBe('judge_own_key');
		// A judged run that cannot be judged does not read its list on either.
		const list = { listFirstPage: 'https://shop.example.invalid/items?page=1' };
		expect(bulkRestartKind({ ...base, ...judged, ...list, haltKey: 'unavailable', judgeOwnKey: true })).toBe('judge_own_key');
		expect(bulkRestartKind({ ...base, ...judged, ...list, haltKey: 'unavailable', judgeServedBy: null })).toBe('no_judge');
		// Not a restart: the waiting halts are starts, a halt with no sentence here offers nothing,
		// and a run past its plan resumes elsewhere.
		expect(bulkRestartKind({ ...base, haltKey: 'awaitingStart' })).toBeNull();
		expect(bulkRestartKind({ ...base, haltKey: 'listed' })).toBeNull();
		expect(bulkRestartKind({ ...base, haltKey: 'expired' })).toBeNull();
		expect(bulkRestartKind({ ...base, haltKey: null })).toBeNull();
		expect(bulkRestartKind({ ...base, phase: 'approved', haltKey: 'unavailable' })).toBeNull();
		expect(bulkRestartKind({ ...base, phase: 'aborted', haltKey: 'contract' })).toBeNull();
	});

	// Every halt the engine can name is placed: restarted, refused, or left to the engine's reason
	// for a stated cause. A new halt reason fails here until it is placed.
	it('places every halt the engine names', () => {
		const STARTS = ['awaitingStart', 'listed'];
		const ENDS_THE_RUN = ['superseded', 'mandateEnded'];
		const WRITE_RUNS_ONLY = ['failureRate', 'expired', 'checksum', 'maxTargets', 'probeRequired', 'atomicRolledBack', 'atomicRollbackIncomplete', 'atomicStoppedRolledBack', 'atomicStoppedRollbackIncomplete', 'atomicTimeRolledBack', 'atomicTimeRollbackIncomplete', 'runUnrecorded', 'shopifyWriteOff'];
		const left = [...STARTS, ...ENDS_THE_RUN, ...WRITE_RUNS_ONLY];
		for (const haltKey of Object.keys(BULK_HALT_REASONS)) {
			const kind = bulkRestartKind({ ...base, haltKey });
			expect(kind === null ? left.includes(haltKey) : !left.includes(haltKey), haltKey).toBe(true);
		}
		expect(left.every((k) => k in BULK_HALT_REASONS)).toBe(true);
	});

	const at = (haltKey: string, o: Partial<Pick<BulkRunDetailData, 'phase' | 'targetSystem' | 'costUsd' | 'costCapUsd' | 'judge'>> = {}) =>
		({ phase: 'planned' as BulkRunDetailData['phase'], haltKey, targetSystem: 'http:shop.example.invalid', costUsd: 0, costCapUsd: null, judge: null, ...o });

	it('has a sentence in both languages for every halt it restarts or refuses', () => {
		for (const key of [...AS_IS.filter((k) => k !== 'judgeModel'), 'costCap', ...NONE]) {
			for (const [lang, table] of [['de', de], ['en', en]] as const) expect(table[`bulk.halt.${key}`], `${lang} ${key}`).toBeTruthy();
		}
		for (const key of ['read', 'list', 'judge', 'kept', 'kept_list', 'cap_low', 'cap_whole', 'none']) {
			expect(de[`bulk.restart.${key}`], key).toBeTruthy();
			expect(en[`bulk.restart.${key}`], key).toBeTruthy();
		}
		for (const key of [...AS_IS, 'costCap', ...NONE]) {
			expect(bulkHaltText(at(key), true, DE)?.cause, key).not.toMatch(/^bulk\./);
			expect(bulkHaltText(at(key), false, EN)?.cause, key).not.toMatch(/^bulk\./);
		}
	});

	it('words the halt with the run\'s provider, host and amounts', () => {
		expect(bulkHaltText(at('unavailable'), true, DE)).toEqual({ cause: 'Der Lauf kam nicht weiter. shop.example.invalid hat nicht geantwortet, oder in lynox ist ein Fehler aufgetreten.', before: null });
		// A judged run may also have stopped on its model.
		expect(bulkHaltText(at('unavailable', { judge: judged.judge }), true, DE)?.cause)
			.toBe('Der Lauf kam nicht weiter. shop.example.invalid oder das KI-Modell hat nicht geantwortet, oder in lynox ist ein Fehler aufgetreten.');
		expect(bulkHaltText(at('unrecorded'), true, EN)).toEqual({ cause: 'lynox could not record a read in your instance\'s log. So lynox stopped reading at that point.', before: null });
		expect(bulkHaltText(at('costCap', { costUsd: 0.0034, costCapUsd: 2 }), true, DE)?.cause)
			.toBe('Der Lauf hat die KI-Kostengrenze erreicht, die du beim Start gesetzt hast: 2.00 USD, verbraucht 0.0034 USD.');
		expect(bulkHaltText(at('blocked'), true, DE)).toEqual({
			cause: 'Deine Instanz darf shop.example.invalid nicht erreichen.',
			before: 'Soll lynox shop.example.invalid erreichen, schreib an support@lynox.ai. Danach kannst du fortsetzen.',
		});
		expect(bulkHaltText(at('consecutiveFailures', { targetSystem: 'data_store' }), true, DE)?.cause)
			.toBe('Dreimal hintereinander liess sich ein Ziel oder eine Seite der Liste nicht lesen.');
	});

	it('keeps the engine\'s reason on a run past its plan, which halts on the same keys for writes', () => {
		for (const phase of ['writing', 'aborted', 'approved'] as const) {
			expect(bulkHaltText(at('consecutiveFailures', { phase }), true, DE), phase).toBeNull();
		}
	});

	it('reads the instance as managed only from a config, unknown otherwise', () => {
		expect(bulkManagedOf(true, { provider: 'anthropic', managed: 'managed_pro' })).toBe(true);
		// A self-hosted instance's config has no `managed` field at all (GET /api/config sets it
		// only when a billing tier is set).
		expect(bulkManagedOf(true, { provider: 'anthropic' })).toBe(false);
		// A refused or failed request carries an error body: no tier in it, and none to read.
		expect(bulkManagedOf(false, { error: 'Unauthorized' })).toBeNull();
		expect(bulkManagedOf(false, { error: 'Service unavailable', managed: null })).toBeNull();
		expect(bulkManagedOf(true, null)).toBeNull();
	});

	it('names the next step by where the instance runs, managed when unknown', () => {
		expect(bulkHaltText(at('blocked'), false, DE)?.before).toBe('Trag shop.example.invalid in der Konfiguration deiner Instanz ein. Danach kannst du fortsetzen.');
		expect(bulkHaltText(at('blocked'), null, DE)?.before).toBe(bulkHaltText(at('blocked'), true, DE)?.before);
		expect(bulkHaltText(at('spendLimit'), true, DE)?.before).not.toMatch(/Limits/);
		expect(bulkHaltText(at('spendLimit'), false, DE)?.before).toMatch(/oder wenn du es unter Einstellungen → Limits anhebst\.$/);
		expect(bulkHaltText(at('spendLimit'), false, EN)?.before).toMatch(/or once you raise it under Settings → Limits\.$/);
	});

	it('gives a refused access the step to reconnect it, and a missing model the start\'s own sentence', () => {
		const reconnect = 'Öffne Einstellungen → APIs und tippe beim Profil für shop.example.invalid auf das Chat-Symbol, um den Zugang neu zu verbinden. Gibt es dort kein Profil, bitte lynox im Chat, den Zugang einzurichten.';
		expect(bulkHaltText(at('credential'), true, DE)?.before).toBe(reconnect);
		expect(bulkHaltText(at('unauthorized'), true, DE)?.before).toBe(reconnect);
		expect(bulkHaltText(at('judgeModel'), true, DE)).toEqual({ cause: de['bulk.start.no_judge_model'], before: null });
		expect(bulkHaltText(at('expired'), true, DE)).toBeNull();
		expect(bulkHaltText(at('awaitingStart'), true, DE)).toBeNull();
	});

	it('shows a small spend, not nothing', () => {
		expect(bulkUsd(0)).toBe('0.00');
		expect(bulkUsd(0.0034)).toBe('0.0034');
		expect(bulkUsd(0.01)).toBe('0.01');
		expect(bulkUsd(1.5)).toBe('1.50');
	});

	it('restarts at the spend limit only with a higher limit', () => {
		expect(bulkRestartCap('3', 2)).toBe(3);
		expect(bulkRestartCap('2,01', 2)).toBe(2.01);
		expect(bulkRestartCap('2', 2)).toBeNull();
		expect(bulkRestartCap('1.50', 2)).toBeNull();
		expect(bulkRestartCap('abc', 2)).toBeNull();
		expect(bulkRestartCap('5', null)).toBe(5);
	});

	// Writing on a run that halted while writing: the halts it moves on from, the ones it cannot,
	// and every sentence the page shows read from the i18n source, both languages.
	const w = (haltKey: string, o: Partial<BulkRunDetailData> = {}) => ({
		phase: 'writing' as BulkRunDetailData['phase'], haltKey, haltReason: 'x', probe: null, targetSystem: 'http:shop.example.invalid',
		probeConfirmed: true, changes: { update: 1000, create: 0, delete: 0, unchanged: 0, invalid: 0 },
		maxTargets: 1000, applied: 550, failed: 51, failedOnce: 70, failureLimit: 50, resumeOpen: 398, resumeTries: 398, ...o,
	});
	const WRITE_ON = ['runUnrecorded', 'unavailable', 'timeBudget', 'stoppedByOwner', 'unrecorded', 'unauthorized', 'credential', 'blocked', 'expired', 'failureRate', 'consecutiveFailures', 'shopifyWriteOff'];

	it('sorts the halts of a write run into writing on, writing on under a higher maximum, and no way on', () => {
		for (const k of WRITE_ON) expect(bulkResumeKind(w(k)), k).toBe('write');
		expect(bulkResumeKind(w('maxTargets'))).toBe('max');
		expect(bulkResumeKind(w('checksum'))).toBe('none');
		expect(bulkResumeKind(w('contract'))).toBe('none');
		// A run halted before its first write (approved, here on an expired approval) writes on too.
		expect(bulkResumeKind(w('expired', { phase: 'approved' }))).toBe('write');
		// Not writing on: a run at its probe has its own way on, a planned run restarts, an ended run does neither.
		expect(bulkResumeKind(w('maxTargets', { probe: { key: 'k', fields: [] } }))).toBeNull();
		expect(bulkResumeKind(w('unavailable', { phase: 'planned' }))).toBeNull();
		expect(bulkResumeKind(w('unavailable', { phase: 'previewed' }))).toBeNull();
		expect(bulkResumeKind(w('atomicRolledBack', { phase: 'aborted' }))).toBeNull();
		expect(bulkResumeKind(w('unavailable', { haltKey: null }))).toBeNull();
	});

	it('offers no way on that the engine refuses for want of a probe', () => {
		// Without a probe a run writes on only under a maximum of one: a higher one is refused.
		expect(bulkResumeKind(w('maxTargets', { probeConfirmed: false, maxTargets: 1 }))).toBeNull();
		// Nor does it write on under a maximum above one, or under none at all.
		expect(bulkResumeKind(w('unavailable', { probeConfirmed: false, maxTargets: 2 }))).toBeNull();
		expect(bulkResumeKind(w('unavailable', { probeConfirmed: false, maxTargets: null }))).toBeNull();
		expect(bulkResumeText(w('failureRate', { probeConfirmed: false }), true, DE)).toBeNull();
		// Under a maximum of one it writes on; with a probe, at any maximum.
		expect(bulkResumeKind(w('unavailable', { probeConfirmed: false, maxTargets: 1 }))).toBe('write');
		expect(bulkResumeKind(w('unavailable', { probeConfirmed: false, maxTargets: null, changes: { update: 1, create: 0, delete: 0, unchanged: 4, invalid: 0 } }))).toBe('write');
		expect(bulkResumeKind(w('unavailable', { maxTargets: null }))).toBe('write');
		// A changed run is past every way on, probe or not.
		expect(bulkResumeKind(w('checksum', { probeConfirmed: false }))).toBe('none');
	});

	it('places every halt the engine names for a write run', () => {
		const PLANNING_ONLY = ['awaitingStart', 'listed', 'listNotAList', 'listUnreadable', 'listTooLarge', 'listNoProgress', 'listFormWithdrawn', 'listOrder', 'listReadFailed', 'shopInactive', 'formCost', 'shopifyReadOff', 'costCap', 'spendLimit', 'creditRefused', 'judgeModel'];
		const NO_WRITE_ON = ['superseded', 'mandateEnded', 'probeRequired', 'atomicRolledBack', 'atomicRollbackIncomplete', 'atomicStoppedRolledBack', 'atomicStoppedRollbackIncomplete', 'atomicTimeRolledBack', 'atomicTimeRollbackIncomplete'];
		const left = [...PLANNING_ONLY, ...NO_WRITE_ON];
		for (const haltKey of Object.keys(BULK_HALT_REASONS)) {
			const kind = bulkResumeKind(w(haltKey));
			expect(kind === null ? left.includes(haltKey) : !left.includes(haltKey), haltKey).toBe(true);
		}
		expect(left.every((k) => k in BULK_HALT_REASONS)).toBe(true);
	});

	it('has every sentence in both languages for every halt it writes on from or refuses', () => {
		for (const k of [...WRITE_ON, 'maxTargets', 'checksum', 'contract']) {
			for (const [lang, i] of [['de', DE], ['en', EN]] as const) {
				const said = bulkResumeText(w(k), true, i)!;
				for (const [part, text] of Object.entries(said)) if (text !== null) expect(text, `${lang} ${k} ${part}`).not.toMatch(/bulk\.|\{/);
			}
		}
	});

	it('words why a write run halted, and what to do first', () => {
		expect(bulkResumeText(w('failureRate'), true, DE)).toMatchObject({
			cause: 'In diesem Durchgang liessen sich mehr als 50 Ziele nicht schreiben.',
			before: 'Prüfe unten die Ziele mit Fehler, bevor du weiterschreibst.',
		});
		// Under twenty targets the halt comes at the first failure.
		expect(bulkResumeText(w('failureRate', { failureLimit: 0 }), true, EN)?.cause).toBe('In this pass, a target could not be written.');
		expect(bulkResumeText(w('consecutiveFailures'), true, DE)?.cause).toBe('Dreimal hintereinander liess sich ein Ziel nicht schreiben.');
		expect(bulkResumeText(w('unrecorded'), true, DE)?.cause).toBe('lynox konnte einen Zugriff auf shop.example.invalid nicht im Protokoll deiner Instanz festhalten. Deshalb hat lynox an dieser Stelle nicht weitergeschrieben.');
		expect(bulkResumeText(w('maxTargets', { maxTargets: 40 }), true, EN)?.cause).toBe('The run reached the approved maximum: 40 targets.');
		expect(bulkResumeText(w('maxTargets', { maxTargets: 1 }), true, DE)?.cause).toBe('Der Lauf hat die freigegebene Höchstzahl erreicht: ein Ziel.');
		expect(bulkResumeText(w('unauthorized'), true, EN)?.before).toBe('Open Settings → APIs and tap the chat icon next to the profile for shop.example.invalid to reconnect the access. If there is no profile, ask lynox in the chat to set up the access.');
		expect(bulkResumeText(w('blocked'), false, DE)?.before).toBe('Trag shop.example.invalid in der Konfiguration deiner Instanz ein. Danach kannst du fortsetzen.');
		expect(bulkResumeText(w('blocked'), null, DE)?.before).toBe(bulkHaltText(at('blocked'), true, DE)?.before);
		expect(bulkResumeText(w('timeBudget'), true, DE)).toMatchObject({ before: null, soFar: null, allows: null });
		// Shopify's own switch: who turns it back on depends on who runs the instance.
		expect(bulkResumeText(w('shopifyWriteOff'), true, DE)).toMatchObject({
			cause: 'Bulk-Änderungen an Shopify-Shops sind auf dieser Instanz nicht freigeschaltet. Der Lauf ist angehalten. Sobald sie wieder freigeschaltet sind, kannst du ihn hier fortsetzen.',
			before: 'Soll lynox in Shopify-Shops schreiben, schreib an support@lynox.ai. Danach kannst du fortsetzen.',
		});
		expect(bulkResumeText(w('shopifyWriteOff'), false, EN)?.before).toBe('You enable them in your instance\'s configuration (`LYNOX_FEATURE_SHOPIFY_BULK_READ`).');
		// No way on past a changed run: no promise of what writing on keeps.
		expect(bulkResumeText(w('checksum'), true, DE)).toEqual({ cause: 'Der Lauf hat sich seit deiner Freigabe geändert.', before: null, kept: null, soFar: null, allows: null });
	});

	it('says all the rest is tried only when the maximum does not stop the pass first', () => {
		expect(bulkResumeText(w('timeBudget'), true, DE)?.kept).toBe('Was schon geschrieben ist, bleibt. lynox versucht alle übrigen Ziele noch einmal. Ausgenommen sind Ziele, deren Inhalt lynox nicht senden darf, und Ziele, bei denen offen ist, ob eine frühere Sendung angekommen ist.');
		expect(bulkResumeText(w('timeBudget', { resumeTries: 4 }), true, DE)?.kept).toBe('Was schon geschrieben ist, bleibt. lynox versucht die übrigen Ziele bis zur freigegebenen Höchstzahl. Ausgenommen sind Ziele, deren Inhalt lynox nicht senden darf, und Ziele, bei denen offen ist, ob eine frühere Sendung angekommen ist.');
		// At its maximum the run writes on under the new one the owner types.
		expect(bulkResumeText(w('maxTargets'), true, EN)?.kept).toBe('What is already written stays. lynox tries the remaining targets up to the approved maximum. Targets whose content lynox may not send are left out, and so are targets where it is unclear whether an earlier send arrived.');
		// With no target confirmed as written, nothing is said to stay — also where targets failed.
		expect(bulkResumeText(w('expired', { phase: 'approved', applied: 0, failed: 0, failedOnce: 0 }), true, DE)?.kept).toBe('Bisher ist kein Ziel als geschrieben bestätigt. lynox versucht jetzt alle Ziele. Ausgenommen sind Ziele, deren Inhalt lynox nicht senden darf, und Ziele, bei denen offen ist, ob eine frühere Sendung angekommen ist.');
		expect(bulkResumeText(w('consecutiveFailures', { applied: 0, failed: 3, failedOnce: 3 }), true, EN)?.kept).toBe('No target is confirmed as written yet. lynox now tries all targets. Targets whose content lynox may not send are left out, and so are targets where it is unclear whether an earlier send arrived.');
		expect(bulkResumeText(w('unavailable', { applied: 0, resumeTries: 4 }), true, DE)?.kept).toBe('Bisher ist kein Ziel als geschrieben bestätigt. lynox versucht jetzt die Ziele bis zur freigegebenen Höchstzahl. Ausgenommen sind Ziele, deren Inhalt lynox nicht senden darf, und Ziele, bei denen offen ist, ob eine frühere Sendung angekommen ist.');
		expect(bulkResumeText(w('unavailable', { applied: 0, resumeTries: 4 }), true, EN)?.kept).toBe('No target is confirmed as written yet. lynox now tries the targets up to the approved maximum. Targets whose content lynox may not send are left out, and so are targets where it is unclear whether an earlier send arrived.');
	});

	it('counts the targets failed so far, as at least the ones failed now on a run from before the count', () => {
		expect(bulkResumeText(w('failureRate'), true, DE)?.soFar).toBe('70 Ziele sind bisher mindestens einmal gescheitert.');
		expect(bulkResumeText(w('consecutiveFailures', { failedOnce: 1 }), true, EN)?.soFar).toBe('1 target has failed at least once so far.');
		expect(bulkResumeText(w('failureRate', { failedOnce: null }), true, DE)?.soFar).toBe('Bisher sind mindestens 51 Ziele gescheitert.');
		expect(bulkResumeText(w('failureRate', { failedOnce: null, failed: 1 }), true, EN)?.soFar).toBe('So far at least 1 target has failed.');
	});

	it('says what writing on lets fail, by the limit against the open targets', () => {
		const allows = (o: Partial<BulkRunDetailData>, i: BulkI18n) => bulkResumeText(w('failureRate', o), true, i)?.allows;
		// The limit below the open targets.
		expect(allows({}, DE)).toBe('Mit dem Weiterschreiben dürfen noch einmal bis zu 50 Ziele scheitern, oder drei in Folge, bevor der Lauf wieder anhält.');
		expect(allows({}, EN)).toBe('If you continue, up to 50 more targets may fail, or three in a row, before the run stops again.');
		expect(allows({ failureLimit: 2 }, EN)).toBe('If you continue, up to 2 more targets may fail before the run stops again.');
		expect(allows({ failureLimit: 1 }, DE)).toBe('Mit dem Weiterschreiben darf noch einmal ein Ziel scheitern, bevor der Lauf wieder anhält.');
		expect(allows({ failureLimit: 1 }, EN)).toBe('If you continue, one more target may fail before the run stops again.');
		expect(allows({ failureLimit: 0 }, EN)).toBe('If you continue, the run stops at the next target that cannot be written.');
		// The limit at or above the open targets: the share cannot be passed.
		expect(allows({ resumeOpen: 38, resumeTries: 38 }, DE)).toBe('Mit dem Weiterschreiben hält der Lauf wegen Fehlschlägen nur noch an, wenn drei Ziele in Folge scheitern.');
		expect(allows({ resumeOpen: 50, resumeTries: 50 }, EN)).toBe('If you continue, the run only stops for failures if three targets in a row fail.');
		expect(allows({ resumeOpen: 3, resumeTries: 3, failureLimit: 3 }, DE)).toBe('Mit dem Weiterschreiben hält der Lauf wegen Fehlschlägen nur noch an, wenn drei Ziele in Folge scheitern.');
		expect(allows({ resumeOpen: 2, resumeTries: 2 }, DE)).toBe('Mit dem Weiterschreiben hält der Lauf nicht mehr wegen Fehlschlägen an. Es sind nur noch 2 Ziele übrig.');
		expect(allows({ resumeOpen: 1, resumeTries: 1 }, EN)).toBe('If you continue, the run no longer stops because of failures. Only one target is left.');
		expect(allows({ resumeOpen: 1, resumeTries: 1 }, DE)).toBe('Mit dem Weiterschreiben hält der Lauf nicht mehr wegen Fehlschlägen an. Es ist nur noch ein Ziel übrig.');
		// Bounded by the open targets, never by the maximum: a target can fail before it is sent to.
		expect(allows({ resumeTries: 1 }, DE)).toBe(allows({}, DE));
		expect(allows({ resumeOpen: 0, resumeTries: 0 }, DE)).toBeNull();
		// Only on a halt on failures.
		expect(bulkResumeText(w('timeBudget'), true, DE)?.allows).toBeNull();
	});

	it('takes a maximum above the current one and at most every target, as a whole number', () => {
		expect(bulkResumeMax(41, 40, 100)).toBe(41);
		expect(bulkResumeMax('100', 40, 100)).toBe(100);
		expect(bulkResumeMax(40, 40, 100)).toBeNull();
		expect(bulkResumeMax(101, 40, 100)).toBeNull();
		expect(bulkResumeMax(41.5, 40, 100)).toBeNull();
		expect(bulkResumeMax(0, null, 100)).toBeNull();
		expect(bulkResumeMax('', 40, 100)).toBeNull();
	});

	// The halts neither a restart nor writing on moves past: a run waiting for its start, one at
	// a probe it may not write past yet, one ended before it was approved.
	const any = (haltKey: string, o: Partial<BulkRunDetailData> = {}) => ({
		...w(haltKey), id: 'run-7', costUsd: 0, costCapUsd: null, judge: null, listFirstPage: null, judgeServedBy: null, judgeOwnKey: false, ...o,
	}) as unknown as BulkRunDetailData;
	const PROBE = { key: 'p-1', fields: ['title'] };

	it('says for every halt the engine has a sentence of its own, never the engine\'s reason', () => {
		// Over the engine's own set: a halt shows in the phase it halts in, so each key needs a
		// sentence in at least one of them; the keys of this page's own sets are held to theirs below.
		for (const haltKey of Object.keys(BULK_HALT_REASONS)) {
			const engine = BULK_HALT_REASONS[haltKey as keyof typeof BULK_HALT_REASONS];
			const said = (['planned', 'writing', 'aborted'] as const).map((phase) =>
				bulkHaltCause(any(haltKey, { phase, haltReason: engine, probe: haltKey === 'probeRequired' ? PROBE : null }), true, 'Ziele lesen', DE));
			expect(said.some((x) => x !== engine && !/bulk\.|\{/.test(x)), haltKey).toBe(true);
		}
	});

	it('words the five halts that had only the engine\'s reason, in both languages', () => {
		for (const [lang, i] of [['de', DE], ['en', EN]] as const) {
			for (const haltKey of ['superseded', 'mandateEnded']) {
				const said = bulkStateText(any(haltKey, { phase: 'aborted' }), null, i);
				expect(said?.cause, `${lang} ${haltKey}`).toBe((lang === 'de' ? de : en)[`bulk.halt.${haltKey}`]);
				expect(said?.step, `${lang} ${haltKey}`).toBeNull();
			}
		}
		// Ended before approval: nothing was written, and the page says so.
		expect(bulkHaltCause(any('superseded', { phase: 'aborted' }), true, null, DE)).toContain('Dieser Lauf hat nichts geschrieben.');
		expect(bulkHaltCause(any('mandateEnded', { phase: 'aborted' }), true, null, EN)).toContain('It wrote nothing.');
	});

	it('at a probe it may not write past, names the panel\'s button only where the panel stands', () => {
		const offered = bulkStateText(any('probeRequired', { probe: PROBE }), null, DE);
		expect(offered).toEqual({ cause: de['bulk.halt.probeRequired'], step: de['bulk.halt.probeRequired_confirm'] });
		// The step names the button exactly as the panel labels it.
		expect(offered!.step).toContain(`„${de['bulk.probe.continue']}“`);
		expect(bulkStateText(any('probeRequired', { probe: PROBE }), null, EN)!.step).toContain(`“${en['bulk.probe.continue']}”`);
		// No probe offered (another run's, or one confirming cannot file): no button to point to.
		const none = bulkStateText(any('probeRequired', { probe: null }), null, DE);
		expect(none).toEqual({ cause: de['bulk.halt.probeRequired'], step: de['bulk.halt.probeRequired_replan'] });
		expect(bulkHaltCause(any('probeRequired', { probe: null }), true, null, EN)).toBe(`${en['bulk.halt.probeRequired']} ${en['bulk.halt.probeRequired_replan']}`);
	});

	it('names the start button a waiting run shows, and says so when it shows none', () => {
		const planned = { phase: 'planned' as const };
		const read = bulkStartButtonKey({ listFirstPage: null, judgeServedBy: null, judgeRule: null }, 'read', false);
		expect(read).toBe('bulk.start.read');
		expect(bulkStateText(any('awaitingStart', planned), DE.t(read!), DE)).toEqual({ cause: 'Der Lauf wartet darauf, dass du ihn mit „Ziele lesen“ startest.', step: null });
		expect(bulkStateText(any('listed', planned), EN.t('bulk.start.list'), EN)).toEqual({ cause: 'Review the targets, then start with “Read the list”.', step: null });
		for (const haltKey of ['awaitingStart', 'listed']) {
			expect(bulkStateText(any(haltKey, planned), null, DE), haltKey).toEqual({ cause: de['bulk.halt.wait_no_start'], step: null });
		}
		// The label is the button's: none where the page shows none.
		const served = { provider: 'anthropic', label: 'm' } as unknown as BulkRunDetailData['judgeServedBy'];
		const rule = {} as BulkRunDetailData['judgeRule'];
		expect(bulkStartButtonKey({ listFirstPage: 'https://x.invalid/l', judgeServedBy: null, judgeRule: null }, 'list', false)).toBe('bulk.start.list');
		expect(bulkStartButtonKey({ listFirstPage: null, judgeServedBy: null, judgeRule: null }, 'list', false)).toBeNull();
		expect(bulkStartButtonKey({ listFirstPage: null, judgeServedBy: served, judgeRule: rule }, 'judge', false)).toBe('bulk.start.judge');
		expect(bulkStartButtonKey({ listFirstPage: null, judgeServedBy: served, judgeRule: rule }, 'judge', true)).toBe('bulk.start.supersede_yes');
		expect(bulkStartButtonKey({ listFirstPage: null, judgeServedBy: served, judgeRule: null }, 'judge', false)).toBeNull();
		for (const kind of ['judge_own_key', 'no_judge', null] as const) expect(bulkStartButtonKey({ listFirstPage: null, judgeServedBy: served, judgeRule: rule }, kind, false), String(kind)).toBeNull();
		// A run that waits for nothing has none of these sentences.
		expect(bulkStateText(any('awaitingStart', { phase: 'writing' }), 'x', DE)).toBeNull();
	});

	it('links to support with the run and host in the subject, only where the sentence names support', () => {
		const planned = any('blocked', { phase: 'planned' });
		const link = bulkSupportMailto(planned, true, DE);
		expect(link).toBe(`mailto:support@lynox.ai?subject=${encodeURIComponent('lynox: Massenlauf run-7 auf shop.example.invalid angehalten')}`);
		expect(bulkSupportMailto(any('shopifyWriteOff'), null, EN)).toBe(`mailto:support@lynox.ai?subject=${encodeURIComponent('lynox: bulk run run-7 on shop.example.invalid halted')}`);
		// The sentence it stands next to names support, and keeps the address readable.
		expect(bulkHaltText(planned, true, DE)?.before).toContain('support@lynox.ai');
		expect(bulkResumeText(any('shopifyWriteOff'), true, DE)?.before).toContain('support@lynox.ai');
		// Self-hosted: the sentence sends the owner to their configuration, not to support.
		expect(bulkSupportMailto(planned, false, DE)).toBeNull();
		expect(bulkHaltText(planned, false, DE)?.before).not.toContain('support@');
		// A halt whose sentence does not name support has no link.
		for (const haltKey of ['unavailable', 'spendLimit', 'credential', 'probeRequired']) {
			expect(bulkSupportMailto(any(haltKey, { phase: 'planned' }), true, DE), haltKey).toBeNull();
			expect(bulkSupportMailto(any(haltKey), true, DE), haltKey).toBeNull();
		}
		// Where the page shows no way on, it shows neither the sentence nor the link.
		expect(bulkSupportMailto(any('blocked', { probeConfirmed: false, maxTargets: 2 }), true, DE)).toBeNull();
		expect(bulkSupportMailto(any('blocked', { phase: 'aborted' }), true, DE)).toBeNull();
	});
});

// Taking a merge back: the page says what came of it by the route's status and code, in the
// owner's language, never the route's English sentence.
describe('taking a merge of two contacts back', () => {
	const source = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf8');
	const ENTRY = /^\s*'([^']+)': \{ de: '((?:[^'\\]|\\.)*)', en: '((?:[^'\\]|\\.)*)' \},$/;
	const de: Record<string, string> = {};
	const en: Record<string, string> = {};
	for (const l of source.split('\n')) {
		const m = ENTRY.exec(l);
		if (m) { de[m[1]!] = m[2]!.replace(/\\'/g, "'"); en[m[1]!] = m[3]!.replace(/\\'/g, "'"); }
	}
	const from = (table: Record<string, string>): BulkI18n => ({
		t: (k) => table[k] ?? k,
		tf: (k, vars) => Object.entries(vars).reduce((s, [name, v]) => s.split(`{${name}}`).join(v), table[k] ?? k),
	});
	const DE = from(de);
	const EN = from(en);
	const merge = { id: 'm-older', dupName: 'Northwind GmbH', canonicalName: 'Northwind', applied: true, inEffect: true };
	const blocker = { id: 'm-newer', dupName: 'Northwind', canonicalName: 'Northwind Holding', applied: true, inEffect: true };
	const list = [blocker, merge];

	it('shows a merge that never completed as not completed, not as no longer in effect', () => {
		expect(bulkMergeState({ applied: false, inEffect: false, superseded: false })).toBe('not_completed');
		expect(bulkMergeState({ applied: false, inEffect: false, superseded: true })).toBe('not_completed');
		expect(bulkMergeState({ applied: true, inEffect: true, superseded: false })).toBe('in_effect');
		expect(bulkMergeState({ applied: true, inEffect: false, superseded: true })).toBe('superseded');
		expect(bulkMergeState({ applied: true, inEffect: false, superseded: false })).toBe('not_in_effect');
		// Offered for taking back only when completed AND in effect: a merge that crashed after the
		// contact graph is in effect there and still not completed, and the route refuses it.
		expect(bulkMergeTakeable({ applied: true, inEffect: true })).toBe(true);
		expect(bulkMergeTakeable({ applied: false, inEffect: true })).toBe(false);
		expect(bulkMergeTakeable({ applied: true, inEffect: false })).toBe(false);
		for (const state of ['not_completed', 'in_effect', 'superseded', 'not_in_effect']) {
			expect(de[`bulk.merges.${state}`], state).toBeTruthy();
			expect(en[`bulk.merges.${state}`], state).toBeTruthy();
		}
	});

	it('gives every code the engine sends its own sentence, in both languages', () => {
		const codes = Object.values(MERGE_REFUSAL_CODES);
		expect(new Set(codes).size, 'two reasons share a code').toBe(codes.length);
		for (const [reason, code] of Object.entries(MERGE_REFUSAL_CODES)) {
			if (code === 'merge_chained') continue;
			for (const [lang, i18n, table] of [['de', DE, de], ['en', EN, en]] as const) {
				const said = bulkMergeAnswer(409, { error: 'English.', code }, merge, list, i18n);
				expect(said.text, `${lang} ${code}`).toBe((table[`bulk.merges.refused.${reason}`] ?? `missing ${reason}`).split('{canonical}').join('Northwind').split('{dup}').join('Northwind GmbH'));
				expect([said.ok, said.goTo], code).toEqual([false, null]);
			}
		}
	});

	it('names the merge in the way when the route names one the list holds, and goes there', () => {
		const said = bulkMergeAnswer(409, { error: 'Take merge m-newer back first: …', code: 'merge_chained', blocking: 'm-newer' }, merge, list, DE);
		expect(said).toEqual({
			text: 'Der Kontakt, in den diese Zusammenführung geführt hat, wurde seither weiter zusammengeführt. Nimm zuerst die Zusammenführung „Northwind“ → „Northwind Holding“ zurück. Danach versuch es hier noch einmal.',
			ok: false,
			goTo: 'm-newer',
		});
	});

	it('says the dead end only when the route names no merge in the way', () => {
		const unnamed = de['bulk.merges.refused.chained_unnamed'];
		expect(unnamed).toBeTruthy();
		for (const body of [{ code: 'merge_chained' }, { code: 'merge_chained', blocking: null }]) {
			expect(bulkMergeAnswer(409, body, merge, list, DE), JSON.stringify(body)).toEqual({ text: unnamed, ok: false, goTo: null });
		}
	});

	it('says the list changed when the merge the route names is no longer one to take back there', () => {
		const changed = de['bulk.merges.refused.chained_changed'];
		expect(changed).toBeTruthy();
		// Gone from the list since, named as this merge itself, or still listed but taken back or
		// never completed: the step the route named is not there now. Not the dead end.
		const cases: [string, typeof list][] = [
			['m-gone', list],
			['m-older', list],
			['m-newer', [{ ...blocker, inEffect: false }, merge]],
			['m-newer', [{ ...blocker, applied: false }, merge]],
			['m-newer', []],
		];
		for (const [blocking, merges] of cases) {
			expect(bulkMergeAnswer(409, { code: 'merge_chained', blocking }, merge, merges, DE), `${blocking} ${JSON.stringify(merges)}`)
				.toEqual({ text: changed, ok: false, goTo: null });
		}
	});

	it('says who may take a merge back, what came of a take-back, and nothing it cannot read', () => {
		// The owner-only refusal carries no code; an access that has ended does.
		expect(bulkMergeAnswer(403, { error: 'Only the owner of this instance can take back a merge.' }, merge, list, DE).text)
			.toBe('Nur der Inhaber dieser Instanz kann eine Zusammenführung zurücknehmen.');
		expect(bulkMergeAnswer(403, { error: 'This access has ended.', code: 'mandate_revoked' }, merge, list, DE).text)
			.toBe(de['bulk.merges.refused.failed']);
		expect(bulkMergeAnswer(200, null, merge, list, DE)).toEqual({ text: '„Northwind GmbH“ ist wieder von „Northwind“ getrennt.', ok: true, goTo: null });
		const unclear = { text: de['bulk.merges.refused.unclear'], ok: false, goTo: null };
		expect(unclear.text).toBeTruthy();
		for (const body of [null, {}, { error: 'Subject merges are not available on this instance.' }, { code: '__proto__' }, { code: 'toString' }, 'text']) {
			expect(bulkMergeAnswer(404, body, merge, list, DE), JSON.stringify(body)).toEqual(unclear);
			expect(bulkMergeAnswer(500, body, merge, list, DE), JSON.stringify(body)).toEqual(unclear);
		}
		// No answer at all (the request failed on the way): status 0.
		expect(bulkMergeAnswer(0, null, merge, list, DE)).toEqual(unclear);
	});

	it('shows supplied names with their hidden characters marked', () => {
		const said = bulkMergeAnswer(200, null, { id: 'x', dupName: 'A\u202Eb', canonicalName: 'C' }, [], DE);
		expect(said.text).toContain('A⟨U+202E⟩b');
	});
});

describe('an owner\'s stop is called a stop, not a halt', () => {
	// „angehalten“ is the word of a run that ended where its approval, a failure or a limit told
	// it to; the owner's stop has its own, so the head above its cause does not read
	// „Angehalten: Der Lauf wurde von Hand gestoppt.“
	const HERE = fileURLToPath(new URL('.', import.meta.url));
	it('the owner\'s stop gets the stop words, every other halt keeps the halt words', () => {
		expect(bulkHaltHeadKey({ haltKey: 'stoppedByOwner' })).toBe('bulk.head.stopped');
		expect(bulkHaltSuffixKey({ haltKey: 'stoppedByOwner' })).toBe('bulk.stopped_suffix');
		for (const haltKey of ['maxTargets', 'costCap', 'consecutiveFailures', null]) {
			expect(bulkHaltHeadKey({ haltKey })).toBe('bulk.head.halted');
			expect(bulkHaltSuffixKey({ haltKey })).toBe('bulk.halted_suffix');
		}
		// the key is the engine's own name for the owner's stop
		expect(Object.keys(BULK_HALT_REASONS)).toContain('stoppedByOwner');
	});
	it('both views ask the helpers, not a fixed key', () => {
		expect(readFileSync(`${HERE}BulkRunDetail.svelte`, 'utf8')).toContain("{t(bulkHaltHeadKey(run))}");
		expect(readFileSync(`${HERE}BulkRunsView.svelte`, 'utf8')).toContain("t(bulkHaltSuffixKey(run))");
		const i18n = readFileSync(`${HERE}../i18n.svelte.ts`, 'utf8');
		expect(i18n).toContain("'bulk.head.stopped': { de: 'Gestoppt', en: 'Stopped' }");
		expect(i18n).toContain("'bulk.stopped_suffix': { de: '· gestoppt', en: '· stopped' }");
	});
});

describe('what the preview says about a target lynox leaves out', () => {
	const HERE = fileURLToPath(new URL('.', import.meta.url));
	// Every reason core can record, read from its union: a reason added there without a decision
	// here turns this red, instead of reaching a Shopify owner as a bare code.
	const ledger = readFileSync(`${HERE}../../../../../src/core/bulk-ledger.ts`, 'utf8');
	const code = ledger.slice(ledger.indexOf('export type BulkInvalidReason =')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	const union = /^export type BulkInvalidReason =([^;]*);/.exec(code)![1]!;
	const reasons = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
	// Reasons no Shopify run can record: a workspace file, a data store row, an effect field
	// (WooCommerce and bexio only).
	const NOT_SHOPIFY = new Set(['path_outside_workspace', 'unreadable', 'target_too_large', 'after_not_text', 'not_text',
		'unknown_column', 'subject_column', 'bad_value', 'bad_key', 'effect_field',
		// The HTML check's reasons: a Shopify run writes no HTML field until descriptions are
		// written (descriptionHtml is refused at planning), so these reach WooCommerce only, by code.
		'element_not_allowed', 'attribute_not_allowed', 'content_changed', 'comment_added', 'new_img', 'new_link_domain',
		'url_scheme', 'url_control_char', 'not_canonical']);
	const i18nSource = readFileSync(`${HERE}../i18n.svelte.ts`, 'utf8');

	it('has a sentence of its own for every reason a Shopify run can record, in both languages', () => {
		expect(reasons.length).toBeGreaterThan(25);
		for (const reason of reasons.filter((r) => !NOT_SHOPIFY.has(r))) {
			const key = bulkInvalidText(reason, true, false, i18n);
			expect(key, reason).toMatch(/^bulk\.invalid\.[a-z_]+$/);
			expect(key, reason).not.toBe('bulk.invalid.other');
			expect(i18nSource, reason).toMatch(new RegExp(`'${key.replace(/\./g, '\\.')}': \\{ de: .+, en: .+ \\}`));
		}
	});
	it('names the reason by its code with the next step on a run that is not Shopify', () => {
		expect(bulkInvalidText('not_found', false, true, i18n)).toBe('bulk.invalid.other');
		const table = { 'bulk.invalid.other': 'skip ({code})' };
		const own: BulkI18n = { t: (k) => table[k as keyof typeof table] ?? k, tf: (k, v) => (table[k as keyof typeof table] ?? k).replace('{code}', v['code']!) };
		expect(bulkInvalidText('read_failed', false, true, own)).toBe('skip (read_failed)');
		// A code is the engine's, but it is shown as text: through bulkVisibleText, as every supplied value.
		const odd = 'read\u202efailed';
		expect(bulkVisibleText(odd)).not.toBe(odd);
		expect(bulkInvalidText(odd, true, true, own)).toBe(`skip (${bulkVisibleText(odd)})`);
	});
	it('adds the way to support on a managed instance only, and an unknown one reads as managed', () => {
		expect(bulkInvalidText('read_failed', true, true, i18n)).toBe('bulk.invalid.read_failed bulk.invalid.persists_support');
		expect(bulkInvalidText('read_failed', true, null, i18n)).toBe('bulk.invalid.read_failed bulk.invalid.persists_support');
		expect(bulkInvalidText('read_failed', true, false, i18n)).toBe('bulk.invalid.read_failed');
		expect(bulkInvalidText('field_not_scalar', true, true, i18n)).toBe('bulk.invalid.shape bulk.invalid.many_support');
		expect(bulkInvalidText('not_found', true, true, i18n)).toBe('bulk.invalid.not_found');
	});

	const counts = (o: Partial<Record<'update' | 'create' | 'delete' | 'unchanged' | 'invalid', number>>, deselected = 0, judge: { tier: string; unjudged: number } | null = null) =>
		({ changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0, ...o }, deselected, judge });
	const vars = (k: string, v: Record<string, string>): string => `${k}${Object.entries(v).map(([a, b]) => ` ${a}=${b}`).join('')}`;
	const echo: BulkI18n = { t: (k) => k, tf: vars };

	it('counts what lynox leaves out and the owner took out in one line, and leaves the approval open', () => {
		expect(bulkSkippedHead(counts({ update: 3, invalid: 2 }), true, echo)).toEqual({ text: 'bulk.skipped.products n=2', nothing: false });
		expect(bulkSkippedHead(counts({ update: 3, invalid: 2 }, 1), true, echo)).toEqual({ text: 'bulk.skipped.both_products n=2 m=1', nothing: false });
		expect(bulkSkippedHead(counts({ update: 3 }, 1), false, echo)).toEqual({ text: 'bulk.skipped.taken_out m=1', nothing: false });
		expect(bulkSkippedHead(counts({ update: 3, unchanged: 4 }), true, echo)).toEqual({ text: null, nothing: false });
		expect(bulkSkippedHead(counts({ create: 1, invalid: 1 }), false, echo).text).toBe('bulk.skipped.targets n=1');
	});
	it('says on a judged run that planning again judges all of it again, only where something was left out', () => {
		const judge = { tier: 'standard', unjudged: 0 };
		expect(bulkSkippedHead(counts({ update: 1, invalid: 1 }, 0, judge), true, echo).text).toBe('bulk.skipped.products n=1 bulk.skipped.judged');
		expect(bulkSkippedHead(counts({ update: 1 }, 2, judge), true, echo).text).toBe('bulk.skipped.taken_out m=2');
		// Nothing left out, nothing to write: no planning again is suggested, so no cost of it is named.
		expect(bulkSkippedHead(counts({ unchanged: 2 }, 0, judge), true, echo).text).toBe('bulk.nothing.products');
	});
	it('shuts the approval when nothing is left to write, and says "all" only where every target is left out', () => {
		expect(bulkSkippedHead(counts({ invalid: 5 }), true, echo)).toEqual({ text: 'bulk.nothing.all_skipped_products n=5', nothing: true });
		expect(bulkSkippedHead(counts({ invalid: 5, unchanged: 1 }), true, echo)).toEqual({ text: 'bulk.nothing.products', nothing: true });
		expect(bulkSkippedHead(counts({ unchanged: 2 }, 3), false, echo)).toEqual({ text: 'bulk.nothing.targets', nothing: true });
		expect(bulkSkippedHead(counts({ delete: 1 }), false, echo).nothing).toBe(false);
	});
});
