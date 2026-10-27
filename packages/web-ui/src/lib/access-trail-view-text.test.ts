import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The access log's texts are operating text only: what a column, an entry kind or a state is
// called. A sentence that says how much the log holds, how long it is kept, that it cannot be
// changed, or what lynox itself sees would be a promise, and those are not decided here. This
// reads the strings as written in the source, both languages, so a new key is covered too.

const SOURCE = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf8');
const KEY = /^\s*'((?:access_trail\.|settings\.account\.access_trail)[^']*)':\s*\{\s*de:\s*'((?:[^'\\]|\\.)*)',\s*en:\s*'((?:[^'\\]|\\.)*)'\s*\},?\s*$/;

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
	['complete', /vollständig|lückenlos|\bcomplete\b|\bfull record\b/i],
	['everything', /\balles\b|\beverything\b|\bevery (?:act|action|access|step)\b|\bjede[rs]? (?:Zugriff|Schritt|Handlung)\b/i],
	['retention', /aufbewahr|gespeichert (?:für|bis)|gelöscht nach|\bretain|\bretention\b|\bkept for\b|\bstored for\b|\bdeleted after\b/i],
	['immutable', /unveränder|nicht (?:verändert|geändert|gelöscht)|fälschungssicher|\bimmutable\b|\btamper|cannot be (?:changed|altered|deleted|removed)/i],
	['what lynox sees', /lynox (?:sieht|liest|hat Zugriff)|lynox (?:sees|reads|can see|has access)/i],
];

const strings = (): Array<{ key: string; lang: 'de' | 'en'; text: string }> =>
	SOURCE.split('\n').flatMap((line) => {
		const m = KEY.exec(line);
		return m === null ? [] : [{ key: m[1]!, lang: 'de' as const, text: m[2]! }, { key: m[1]!, lang: 'en' as const, text: m[3]! }];
	});

const hits = (text: string): string[] => FORBIDDEN.filter(([, re]) => re.test(text)).map(([name]) => name);

describe('the access log says no more than it shows', () => {
	it('reads every one of its keys from the source', () => {
		// Every key line of the block must parse, or a key would slip past the check below.
		const lines = SOURCE.split('\n').filter((l) => /^\s*'(?:access_trail\.|settings\.account\.access_trail)/.test(l));
		expect(lines.length).toBeGreaterThan(40);
		expect(strings()).toHaveLength(lines.length * 2);
	});

	it('no text names how much the log holds, how long it is kept, that it cannot change, or what lynox sees', () => {
		const found = strings().flatMap(({ key, lang, text }) => hits(text).map((h) => `${key} (${lang}): ${h}`));
		expect(found).toEqual([]);
	});

	it('the check finds each kind of forbidden sentence (control)', () => {
		expect(hits('Das Protokoll ist vollständig.')).toEqual(['complete']);
		expect(hits('It records everything a helper does.')).toEqual(['everything']);
		expect(hits('Einträge werden 90 Tage aufbewahrt.')).toEqual(['retention']);
		expect(hits('Entries cannot be deleted.')).toEqual(['immutable']);
		expect(hits('lynox sieht diese Einträge nicht.')).toEqual(['what lynox sees']);
		expect(hits('Letzte 30 Tage')).toEqual([]);
	});
});
