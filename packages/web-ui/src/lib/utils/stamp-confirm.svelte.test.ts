import { describe, it, expect, afterEach } from 'vitest';
import { mandateNeedsOwnerStamp } from '../../../../../src/core/request-principal.js';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { segments, VALUE_CLOSE, VALUE_OPEN } from './plan-takeover.js';
import { awaitsOwnerStamp, confirmable, connectionsParts, connectionsSentence, hiddenIn, hiddenNote, hidesText, listedLine, listedNote, paramsOf, readPreview, shownAs, stampable, usesConnections, type StampPreview } from './stamp-confirm.js';

/** A value someone else wrote, between the marks `shownValue` sets. */
const v = (x: string): string => `${VALUE_OPEN}${x}${VALUE_CLOSE}`;

const before = getLocale();
afterEach(() => { setLocale(before); });

const preview = (over: Partial<StampPreview> = {}, subject: Partial<StampPreview['subject']> = {}): StampPreview => ({
	expect: 'd',
	subject: {
		id: 't1', effect: 'run_agent', source: 'cron', title: 'Report', description: null, schedule_cron: null, watch: null,
		pipeline_id: null, pipeline_params: null, model_tier: null, wf: null, ...subject,
	},
	by: 'eva@kanzlei.example',
	workflow: null,
	connections: [],
	...over,
});

describe('awaitsOwnerStamp', () => {
	it('decides what the engine holds, on every combination of the three fields', () => {
		// The engine's rule, not a copy: the view hides run-now and offers the stamp exactly where
		// the run is held, and a row the view thinks free while the engine holds it would offer a run
		// that is refused.
		const tags = [undefined, '', 'owner', 'mandate:eva@kanzlei.example', 'MANDATE:eva', 'mandatex'];
		let rows = 0;
		for (const confirmed_at of [undefined, '', '2026-10-01T00:00:00.000Z']) {
			for (const created_by of tags) {
				for (const edited_by of tags) {
					const row = { confirmed_at, created_by, edited_by };
					expect(awaitsOwnerStamp(row), JSON.stringify(row)).toBe(mandateNeedsOwnerStamp(row));
					rows++;
				}
			}
		}
		expect(rows).toBe(108);
		// And both sides of it occur, so the table is not one answer repeated.
		expect(awaitsOwnerStamp({ created_by: 'mandate:eva@kanzlei.example' })).toBe(true);
		expect(awaitsOwnerStamp({ created_by: 'mandate:eva@kanzlei.example', edited_by: 'owner' })).toBe(false);
	});
});

describe('stampable and usesConnections', () => {
	it('offers no stamp at a paused plan or a bulk effect', () => {
		expect(stampable({ effect: 'run_agent' })).toBe(true);
		expect(stampable({ effect: 'run_agent', paused: true })).toBe(false);
		expect(stampable({ effect: 'bulk_write' })).toBe(false);
	});
	it('offers the check only where a run can use a connection', () => {
		expect(['run_agent', 'run_workflow', 'backup', 'notify', 'bulk_apply', undefined].map((effect) => usesConnections({ effect }))).toEqual([true, true, false, false, false, false]);
	});
});

describe('what the preview shows', () => {
	it('decides the display the way the run decides it', () => {
		expect(shownAs(preview({}, { effect: 'run_workflow', pipeline_id: 'wf-1' }))).toBe('workflow');
		expect(shownAs(preview({}, { source: 'watch', watch: JSON.stringify({ url: 'https://a.example/p' }) }))).toBe('watch');
		expect(shownAs(preview({}, { source: 'watch', watch: JSON.stringify({ url: 'ftp://a.example/p' }) }))).toBe('unreadable_watch');
		expect(shownAs(preview({}, { source: 'watch', watch: null }))).toBe('unreadable_watch');
		// A watch config on a run that is not a watch: the run gets the text, so the text is shown.
		expect(shownAs(preview({}, { source: 'cron', watch: JSON.stringify({ url: 'https://a.example/p' }) }))).toBe('instruction');
	});

	it('offers no confirm on a watch it cannot show, or on an unconfirmed workflow', () => {
		expect(confirmable(preview())).toBe(true);
		expect(confirmable(preview({}, { source: 'watch', watch: 'not json' }))).toBe(false);
		expect(confirmable(preview({ workflow: { name: 'W', confirmed: false } }, { effect: 'run_workflow' }))).toBe(false);
		expect(confirmable(preview({ workflow: { name: 'W', confirmed: true } }, { effect: 'run_workflow' }))).toBe(true);
	});

	it('offers no confirm when shown text had characters the display takes out', () => {
		// The run hands the stored text to the model: what the owner cannot read must not run on their stamp.
		const ZW = '\u200B';
		const TAG = String.fromCodePoint(0xE0041);
		expect(hidesText(preview())).toBe(false);
		expect(hidesText(preview({}, { title: `Report${ZW}` }))).toBe(true);
		expect(hidesText(preview({}, { description: `Send it.${TAG}` }))).toBe(true);
		expect(hidesText(preview({ workflow: { name: 'W', confirmed: true } }, { effect: 'run_workflow', pipeline_id: 'wf-1', pipeline_params: `{"to":"all${ZW}"}` }))).toBe(true);
		expect(hidesText(preview({ by: `eva${ZW}@kanzlei.example` }))).toBe(true);
		expect(hidesText(preview({ workflow: { name: `W${TAG}`, confirmed: true } }, { effect: 'run_workflow', pipeline_id: 'wf-1' }))).toBe(true);
		expect(hidesText(preview({ connections: [{ id: 'c', profile: 'p', provider: 'CRM', account: `eva${ZW}@crm` }] }))).toBe(true);
		// Line breaks and tabs are an instruction's own layout, not hidden text.
		expect(hidesText(preview({}, { description: 'One.\n\tTwo.' }))).toBe(false);
		expect(confirmable(preview({}, { title: `Report${ZW}` }))).toBe(false);
		// A soft hyphen is common in pasted text and cannot hold a clause.
		expect(hidesText(preview({}, { description: 'Rech\u00ADnung' }))).toBe(false);
		// In the workflow's name, the way out has to remove the workflow too.
		expect(hiddenIn(preview({ workflow: { name: `W${TAG}`, confirmed: true } }, { effect: 'run_workflow', pipeline_id: 'wf-1', pipeline_params: `{"to":"all${ZW}"}` }))).toBe('workflow');
		expect(hiddenIn(preview({ workflow: { name: 'W', confirmed: true } }, { effect: 'run_workflow', pipeline_id: 'wf-1', pipeline_params: `{"to":"all${ZW}"}` }))).toBe('plan');
		expect(hiddenIn(preview())).toBeNull();
	});

	it('looks only at what the block shows for the kind, and at values as the block shows them', () => {
		const ZW = '\u200B';
		const wf = { workflow: { name: 'W', confirmed: true } };
		// A workflow or watch run never hands its title to the model, and the block does not show it.
		expect(hiddenIn(preview(wf, { effect: 'run_workflow', pipeline_id: 'wf-1', title: `T${ZW}` }))).toBeNull();
		expect(hiddenIn(preview({}, { source: 'watch', title: `T${ZW}`, watch: JSON.stringify({ url: 'https://a.example/p' }) }))).toBeNull();
		// The run writes the stored URL into the model's prompt, though the block shows it parsed.
		expect(hiddenIn(preview({}, { source: 'watch', watch: JSON.stringify({ url: `https://a.example/p${String.fromCodePoint(0xE0041)}` }) }))).toBe('plan');
		// The selector is shown, and checked.
		expect(hiddenIn(preview({}, { source: 'watch', watch: JSON.stringify({ url: 'https://a.example/p', selector: `#a${ZW}` }) }))).toBe('plan');
		// A control character inside a value, which the raw JSON would hide behind an escape.
		expect(hiddenIn(preview(wf, { effect: 'run_workflow', pipeline_id: 'wf-1', pipeline_params: JSON.stringify({ to: 'all\u0001' }) }))).toBe('plan');
		// Windows line endings are pasted text, not a hidden clause.
		expect(hiddenIn(preview({}, { description: 'One.\r\nTwo.' }))).toBeNull();
	});

	it('says in the check that a confirmed plan still runs', () => {
		setLocale('de');
		expect(hiddenNote(false, false)).not.toContain('läuft trotzdem weiter');
		expect(hiddenNote(false, true)).toContain('läuft trotzdem weiter');
		expect(hiddenNote(true, true)).toContain('in seinem Workflow');
		expect(hiddenNote(true, false)).toContain('in seinem Workflow');
		expect(hiddenNote(true, false)).not.toContain('läuft trotzdem weiter');
	});

	it('does not say the ended person wrote the workflow when someone else did', () => {
		setLocale('de');
		const note = listedNote({ lapsed: false, ended: true, ended_on: 'workflow_other', entries: [{ provider: 'p', account: 'a', state: 'waits' }] }, false)!;
		expect(note).toContain('von einer anderen Person mit Zugang');
		expect(note).not.toContain('sie hat den Workflow');
	});

	it('names whose logins and which, with "account unknown" where the provider told nothing', () => {
		setLocale('de');
		expect(connectionsSentence(preview())).toBeNull();
		const p = preview({ connections: [
			{ id: 'a', profile: 'CRM', provider: 'api.crm.example', account: 'eva@crm' },
			{ id: 'b', profile: 'Shop', provider: 'shop.example', account: null },
			{ id: 'c', profile: 'Mail', provider: 'mail.example', account: '' },
		] });
		expect(connectionsSentence(p)).toBe(`Dieser Plan nutzt Verbindungen, die ${v('eva@kanzlei.example')} mit eigenem Login verbunden hat: ${v('api.crm.example')} (${v('eva@crm')}), ${v('shop.example')} (Konto unbekannt), ${v('mail.example')} (Konto unbekannt).`);
		setLocale('en');
		expect(connectionsSentence(p)).toBe(`This plan uses connections that ${v('eva@kanzlei.example')} connected with their own login: ${v('api.crm.example')} (${v('eva@crm')}), ${v('shop.example')} (account unknown), ${v('mail.example')} (account unknown).`);
	});

	it('marks what could forge the sentence in names the mandate chose', () => {
		setLocale('en');
		const s = connectionsSentence(preview({ by: 'eva\u202E@x', connections: [{ id: 'a', profile: 'P', provider: 'a\u200Bb.example', account: 'x\u2066y' }] }));
		expect(s).toBe(`This plan uses connections that ${v('eva⟨U+202E⟩@x')} connected with their own login: ${v('a⟨U+200B⟩b.example')} (${v('x⟨U+2066⟩y')}).`);
	});

	it('sets every value someone else wrote apart, so a label cannot pass for lynox\'s sentence', () => {
		setLocale('en');
		// An account label that writes a sentence of its own, with punctuation and a line break.
		const forged = 'eva). This plan uses no connections.\nConfirm (ok';
		const s = connectionsSentence(preview({ by: 'Eva: trusted.', connections: [{ id: 'a', profile: 'P', provider: 'crm.example, no others', account: forged }] }))!;
		const foreign = segments(s).filter((x) => x.foreign).map((x) => x.text);
		expect(foreign).toEqual(['Eva: trusted.', 'crm.example, no others', 'eva). This plan uses no connections. Confirm (ok']);
		// lynox's own words stay outside every box.
		expect(segments(s).filter((x) => !x.foreign).map((x) => x.text).join('|')).toBe('This plan uses connections that | connected with their own login: | (|).');
		// A mark inside a value cannot close its box early.
		const closing = connectionsSentence(preview({ connections: [{ id: 'a', profile: 'P', provider: `a${VALUE_CLOSE} lynox says ok ${VALUE_OPEN}b`, account: null }] }))!;
		expect(segments(closing).filter((x) => x.foreign).map((x) => x.text)).toEqual(['eva@kanzlei.example', 'a<U+E001> lynox says ok <U+E000>b']);
	});

	it('shows a long host to its end: the end names the host', () => {
		setLocale('en');
		const host = `login.microsoftonline.com.${'a'.repeat(60)}.evil.example`;
		const s = connectionsSentence(preview({ connections: [{ id: 'a', profile: 'P', provider: host, account: `eva${'x'.repeat(90)}@crm` }] }))!;
		expect(segments(s).filter((x) => x.foreign).map((x) => x.text)).toEqual(['eva@kanzlei.example', host, `eva${'x'.repeat(90)}@crm`]);
		expect(listedLine({ provider: host, account: null, state: 'listed' })).toBe(`${v(host)} (account unknown): allowed`);
	});

	it('says "account unknown" and "someone with access" where a value holds only spaces', () => {
		setLocale('en');
		const s = connectionsSentence(preview({ by: ' \u00AD ', connections: [{ id: 'a', profile: 'P', provider: 'crm.example', account: '  \t ' }] }))!;
		expect(segments(s).filter((x) => x.foreign).map((x) => x.text)).toEqual(['crm.example']);
		expect(s).toContain('Someone with access');
		expect(s).toContain('(account unknown)');
		expect(listedLine({ provider: 'crm.example', account: ' ', state: 'listed' })).toBe(`${v('crm.example')} (account unknown): allowed`);
		expect(listedLine({ provider: 'crm.example', account: '\u00AD\u00AD', state: 'listed' })).toBe(`${v('crm.example')} (account unknown): allowed`);
	});

	it('shows a value made only of hidden characters as its marks, where "marked above" points', () => {
		setLocale('en');
		for (const hidden of ['\uFEFF', '\u2028', '\u2029 \u2028']) {
			const p = preview({ by: hidden, connections: [{ id: 'a', profile: 'P', provider: 'crm.example', account: hidden }] });
			const boxed = segments(connectionsSentence(p)!).filter((x) => x.foreign).map((x) => x.text);
			expect(boxed, JSON.stringify(hidden)).toHaveLength(3);
			for (const b of [boxed[0]!, boxed[2]!]) expect(b, JSON.stringify(hidden)).toMatch(/⟨U\+(FEFF|2028|2029)⟩/);
			expect(hiddenIn(p)).toBe('plan');
			expect(listedLine({ provider: 'crm.example', account: hidden, state: 'listed' })).toMatch(/⟨U\+(FEFF|2028|2029)⟩/);
		}
	});

	it('lays the sentence out one connection per line, and its parts read as the sentence', () => {
		const p = preview({ connections: [
			{ id: 'a', profile: 'CRM', provider: 'api.crm.example', account: 'eva@crm' },
			{ id: 'b', profile: 'Shop', provider: 'shop.example', account: null },
		] });
		setLocale('de');
		const de = connectionsParts(p)!;
		expect(de.lead).toBe(`Dieser Plan nutzt Verbindungen, die ${v('eva@kanzlei.example')} mit eigenem Login verbunden hat: `);
		expect(de.items).toEqual([`${v('api.crm.example')} (${v('eva@crm')}),`, `${v('shop.example')} (Konto unbekannt).`]);
		expect(de.lead + de.items.join(' ')).toBe(connectionsSentence(p));
		setLocale('en');
		const en = connectionsParts(p)!;
		expect(en.items).toEqual([`${v('api.crm.example')} (${v('eva@crm')}),`, `${v('shop.example')} (account unknown).`]);
		expect(en.lead + en.items.join(' ')).toBe(connectionsSentence(p));
		expect(connectionsParts(preview())).toBeNull();
	});

	it('shows a name with an emoji or a joiner as written, with no mark the note does not explain', () => {
		setLocale('en');
		for (const name of ['Eva \u2764\uFE0F', 'Fam \u{1F468}\u200D\u{1F469}', 'Mi\u200Cr']) {
			const p = preview({ by: name, connections: [{ id: 'a', profile: 'P', provider: 'crm.example', account: name }] });
			const boxed = segments(connectionsSentence(p)!).filter((x) => x.foreign).map((x) => x.text);
			expect(boxed, JSON.stringify(name)).toEqual([name, 'crm.example', name]);
			expect(hiddenIn(p)).toBeNull();
		}
	});

	it('says an unnamed person in lynox\'s words, not as a value', () => {
		setLocale('en');
		const s = connectionsSentence(preview({ by: null, connections: [{ id: 'a', profile: 'P', provider: 'crm.example', account: null }] }))!;
		expect(segments(s).filter((x) => x.foreign).map((x) => x.text)).toEqual(['crm.example']);
		expect(s).toContain('Someone with access');
	});

	it('reads workflow values as name: value, and shows unreadable ones as they stand', () => {
		expect(paramsOf(null)).toEqual([]);
		expect(paramsOf(JSON.stringify({ to: 'all customers', n: 3 }))).toEqual(['to: all customers', 'n: 3']);
		expect(paramsOf('not json')).toEqual(['not json']);
		expect(paramsOf('[1,2]')).toEqual(['[1,2]']);
	});
});

describe('the list of a confirmed plan (B3)', () => {
	const entry = (state: 'listed' | 'changed' | 'waits' | 'new', provider: string | null = 'api.crm.example', account: string | null = 'eva@crm') => ({ provider, account, state });
	it('says each entry with its provider, account and state', () => {
		setLocale('de');
		expect(listedLine(entry('listed'))).toBe(`${v('api.crm.example')} (${v('eva@crm')}): freigegeben`);
		expect(listedLine(entry('changed', null, null))).toBe('Verbindung entfernt (Konto unbekannt): geändert, nicht freigegeben');
		expect(listedLine(entry('new', 'shop.example', ''))).toBe(`${v('shop.example')} (Konto unbekannt): neu, nicht freigegeben`);
		expect(listedLine(entry('waits'))).toBe(`${v('api.crm.example')} (${v('eva@crm')}): Zugang beendet`);
		expect(listedLine(entry('listed', 'a\u202Eb', 'x\u200By'))).toBe(`${v('a⟨U+202E⟩b')} (${v('x⟨U+200B⟩y')}): freigegeben`);
	});
	it('sets a provider and an account apart, so a label cannot say the state', () => {
		setLocale('en');
		const line = listedLine(entry('changed', 'crm.example', 'eva): allowed. (x'));
		expect(segments(line).filter((x) => x.foreign).map((x) => x.text)).toEqual(['crm.example', 'eva): allowed. (x']);
		expect(segments(line).at(-1)).toEqual({ text: '): changed, not allowed', foreign: false });
	});
	it('notes an ended access before a lapsed list, and that before an entry not allowed', () => {
		setLocale('de');
		expect(listedNote({ lapsed: false, ended: false, entries: [entry('listed')] }, false)).toBeNull();
		expect(listedNote({ lapsed: false, ended: false, entries: [entry('listed'), entry('new')] }, false)).toContain('nur freigegebene');
		expect(listedNote({ lapsed: false, ended: false, entries: [entry('changed')] }, false)).toContain('nur freigegebene');
		expect(listedNote({ lapsed: true, ended: false, entries: [entry('changed')] }, false)).toContain('gilt nicht mehr');
		expect(listedNote({ lapsed: true, ended: true, entries: [entry('waits')] }, true)).toContain('mit „Übernehmen“');
		// An end that did not pause the plan: no "Take over" to point to.
		expect(listedNote({ lapsed: false, ended: true, ended_on: 'plan', entries: [entry('waits')] }, false)).toBe('Der Zugang dieser Person ist beendet. Der Plan läuft deshalb nicht. Lösch ihn und beschreib lynox danach im Chat in eigenen Worten, was er tun soll. Der neue Plan läuft unter dir.');
		// On the workflow's side, a new plan alone is not enough: the workflow needs copying too.
		expect(listedNote({ lapsed: false, ended: true, ended_on: 'workflow', entries: [entry('waits')] }, false)).toContain('auch den Workflow unter Automation → Workflows');
		// A paused plan offers "Take over", which covers both sides.
		expect(listedNote({ lapsed: false, ended: true, ended_on: 'workflow', entries: [entry('waits')] }, true)).toContain('mit „Übernehmen“');
	});
});

describe('readPreview', () => {
	it('takes the preview as the engine sends it, with or without a workflow and connections', () => {
		const p = preview();
		expect(readPreview(p)).toBe(p);
		const wf = preview({ workflow: { name: null, confirmed: false }, by: null, connections: [{ id: 'c', profile: 'CRM', provider: 'api.crm.example', account: null }] }, { effect: 'run_workflow', pipeline_id: 'wf-1' });
		expect(readPreview(wf)).toBe(wf);
	});

	it('refuses every other shape, field by field', () => {
		const p = preview() as unknown as Record<string, unknown>;
		const sub = p['subject'] as Record<string, unknown>;
		const bad: unknown[] = [
			null, [], 'x', {},
			{ ...p, expect: '' }, { ...p, expect: 1 }, { ...p, by: 1 },
			{ ...p, subject: undefined }, { ...p, subject: [] }, { ...p, subject: { ...sub, id: 1 } }, { ...p, subject: { ...sub, title: null } },
			{ ...p, subject: { ...sub, effect: 1 } }, { ...p, subject: { ...sub, wf: {} } }, { ...p, subject: { ...sub, description: undefined } },
			{ ...p, workflow: { name: 'W' } }, { ...p, workflow: 'W' }, { ...p, workflow: { name: 'W', confirmed: true, ended: 'yes' } },
			{ ...p, connections: undefined }, { ...p, connections: [{ id: 'c', profile: 'CRM', provider: 'x' }] }, { ...p, connections: [null] },
		];
		expect(bad.map((b) => readPreview(b))).toEqual(bad.map(() => null));
	});
});
