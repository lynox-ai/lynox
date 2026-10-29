import { describe, it, expect, afterEach } from 'vitest';
import { mandateNeedsOwnerStamp } from '../../../../../src/core/request-principal.js';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { awaitsOwnerStamp, confirmable, connectionsSentence, listedLine, listedNote, paramsOf, shownAs, stampable, usesConnections, type StampPreview } from './stamp-confirm.js';

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
		expect(['run_agent', 'run_workflow', 'backup', 'reminder', undefined].map((effect) => usesConnections({ effect }))).toEqual([true, true, false, false, false]);
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

	it('names whose logins and which, with "account unknown" where the provider told nothing', () => {
		setLocale('de');
		expect(connectionsSentence(preview())).toBeNull();
		const p = preview({ connections: [
			{ id: 'a', profile: 'CRM', provider: 'api.crm.example', account: 'eva@crm' },
			{ id: 'b', profile: 'Shop', provider: 'shop.example', account: null },
			{ id: 'c', profile: 'Mail', provider: 'mail.example', account: '' },
		] });
		expect(connectionsSentence(p)).toBe('Dieser Plan nutzt Verbindungen, die eva@kanzlei.example mit eigenem Login verbunden hat: api.crm.example (eva@crm), shop.example (Konto unbekannt), mail.example (Konto unbekannt).');
		setLocale('en');
		expect(connectionsSentence(p)).toBe('This plan uses connections that eva@kanzlei.example connected with their own login: api.crm.example (eva@crm), shop.example (account unknown), mail.example (account unknown).');
	});

	it('removes what could forge the sentence from names the mandate chose', () => {
		setLocale('en');
		const s = connectionsSentence(preview({ by: 'eva‮@x', connections: [{ id: 'a', profile: 'P', provider: 'a​b.example', account: 'x⁦y' }] }));
		expect(s).toBe('This plan uses connections that eva@x connected with their own login: ab.example (xy).');
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
		expect(listedLine(entry('listed'))).toBe('api.crm.example (eva@crm): freigegeben');
		expect(listedLine(entry('changed', null, null))).toBe('Verbindung entfernt (Konto unbekannt): geändert, nicht freigegeben');
		expect(listedLine(entry('new', 'shop.example', ''))).toBe('shop.example (Konto unbekannt): neu, nicht freigegeben');
		expect(listedLine(entry('waits'))).toBe('api.crm.example (eva@crm): Zugang beendet');
		expect(listedLine(entry('listed', 'a\u202Eb', 'x\u200By'))).toBe('ab (xy): freigegeben');
	});
	it('notes an ended access before a lapsed list, and that before an entry not allowed', () => {
		setLocale('de');
		expect(listedNote({ lapsed: false, ended: false, entries: [entry('listed')] })).toBeNull();
		expect(listedNote({ lapsed: false, ended: false, entries: [entry('listed'), entry('new')] })).toContain('nur freigegebene');
		expect(listedNote({ lapsed: false, ended: false, entries: [entry('changed')] })).toContain('nur freigegebene');
		expect(listedNote({ lapsed: true, ended: false, entries: [entry('changed')] })).toContain('gilt nicht mehr');
		expect(listedNote({ lapsed: true, ended: true, entries: [entry('waits')] })).toContain('Zugang dieser Person ist beendet');
	});
});
