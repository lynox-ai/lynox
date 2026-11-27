import { describe, it, expect, afterEach } from 'vitest';
import { getLocale, setLocale, t } from './i18n.svelte.js';
import { LEGACY_TIER_ALIASES } from './contract/vocab.js';
import { STAMP_EFFORTS, STAMP_THINKING } from './utils/workflow-stamp.js';

// A tier, a thoroughness and a thinking setting carry the names the settings use (`tier-words.ts`),
// in the fixed texts too, not only where a view reads a stored value. This reads every text of
// both languages through `t`, so a text written over several lines or in double quotes is read
// as well, and refuses the stored values in the forms they took when a text named them.

const { default: SOURCE } = (await import('./i18n.svelte.ts?raw')) as { default: string };
const KEYS = [...SOURCE.matchAll(/^\t'([^']+)':\s*\{/gm)].map((m) => m[1]!);

// The stored values, from where they are defined: tiers and their older aliases (`contract/vocab.ts`),
// thoroughness and thinking (`STAMP_EFFORTS`, `STAMP_THINKING`). Every form below is built from these
// lists, and the controls go through the same lists value by value, so no value goes unchecked.
const TIERS = [...new Set(Object.values(LEGACY_TIER_ALIASES))];
const VALUES = [...new Set([...TIERS, ...Object.keys(LEGACY_TIER_ALIASES), ...STAMP_EFFORTS, ...STAMP_THINKING])];
const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

// What each form leaves alone, and why. A German text: `fast` and `Fast` are German words, `max` and
// `Max` the name of a placeholder (`{max}`) and of a plan; `Haiku`, `Sonnet`, `Opus` and `Medium` (in
// `Magistral Medium`) are model names. In brackets `max` means a maximum (`Per sub-agent (max)`).
const DE_LEFT_ALONE: ReadonlySet<string> = new Set(['fast', 'Fast', 'max', 'Max', 'Haiku', 'Sonnet', 'Opus', 'Medium']);
const BRACKETS_LEFT_ALONE: ReadonlySet<string> = new Set(['max']);
// The verbs a text set a tier with (`Run on balanced`, `Allow deep`), each also with a capital.
const VERBS = ['on', 'to', 'allow', 'use', 'uses'];

const DE_WORDS = VALUES.flatMap((v) => [v, cap(v)]).filter((v) => !DE_LEFT_ALONE.has(v));
const IN_BRACKETS = VALUES.filter((v) => !BRACKETS_LEFT_ALONE.has(v));
const any = (vs: readonly string[]): string => `(?:${vs.join('|')})`;
// A model id (`claude-3-5-sonnet-…`) is not a stored value: a hyphen or a letter next to it leaves it alone.
const BARE = (re: string): string => `(?<![\\w-])${re}(?![\\w-])`;
const TOKEN = any(VALUES);

const FORMS: ReadonlyArray<[string, RegExp, 'de' | 'en' | 'both']> = [
	// A German text has no English word for a tier: a stored value in it is the value itself, and so
	// is the English word with a capital (`Deep erlauben`).
	['stored value in a German text', new RegExp(BARE(any(DE_WORDS))), 'de'],
	// No language has this word.
	['xhigh', new RegExp(BARE('xhigh')), 'both'],
	// The forms a text used for the values: a list with slashes, a value in brackets or in quotes, a
	// value marked as the default, a value naming a tier, and in English a value after a verb that sets it.
	['values in a slash list', new RegExp(BARE(`${TOKEN}\\s*/\\s*${TOKEN}`)), 'both'],
	['value in brackets', new RegExp(`\\(\\s*${any(IN_BRACKETS)}\\s*\\)`), 'both'],
	['value in quotes', new RegExp(`[\`"„“'‘]${TOKEN}[\`"“”'’]`), 'both'],
	['value marked as the default', new RegExp(BARE(`${TOKEN}\\s*\\((?:default|Standard)\\)`)), 'both'],
	['value naming a tier', new RegExp(BARE(`${any(TIERS)}\\s+(?:tier|Stufe)`)), 'both'],
	['value after a verb that sets it', new RegExp(BARE(`${any(VERBS.flatMap((v) => [v, cap(v)]))}\\s+${any(TIERS)}`)), 'en'],
];

const hits = (text: string, lang: 'de' | 'en'): string[] =>
	FORMS.filter(([, re, l]) => (l === 'both' || l === lang) && re.test(text)).map(([name]) => name);

function texts(lang: 'de' | 'en'): Array<{ key: string; text: string }> {
	setLocale(lang);
	return KEYS.map((key) => ({ key, text: t(key) }));
}

describe('no fixed text names a tier, a thoroughness or a thinking setting by its stored value', () => {
	const was = getLocale();
	afterEach(() => setLocale(was));

	it('reads every text of both languages', () => {
		// A positive control: the keys are found, and each one reads a text, not its key.
		expect(KEYS.length).toBeGreaterThan(3000);
		expect(new Set(KEYS).size).toBe(KEYS.length);
		// Every value of the dictionary belongs to a key read here: a key in double quotes, at another
		// indent or computed would leave its values over.
		const dict = SOURCE.slice(SOURCE.indexOf('const translations'), SOURCE.indexOf('\n};', SOURCE.indexOf('const translations')));
		expect(dict.length).toBeGreaterThan(100000);
		expect(dict.match(/\bde:\s/g)?.length).toBe(KEYS.length);
		expect(dict.match(/\ben:\s/g)?.length).toBe(KEYS.length);
		for (const lang of ['de', 'en'] as const) {
			const missing = texts(lang).filter(({ key, text }) => text === key || text === '');
			expect(missing, lang).toEqual([]);
		}
		// Each language is read in that language.
		expect(texts('de').find(({ key }) => key === 'llm.tier.balanced')?.text).toBe('Ausgewogen');
		expect(texts('en').find(({ key }) => key === 'llm.tier.balanced')?.text).toBe('Balanced');
		// A text over several lines and one in double quotes are among them.
		expect(KEYS).toContain('spawn.est_max_hint');
		expect(KEYS).toContain('triggers.awaiting_hint');
	});

	it('no text in German or English carries a stored value', () => {
		const found: string[] = [];
		for (const lang of ['de', 'en'] as const) {
			for (const { key, text } of texts(lang)) for (const h of hits(text, lang)) found.push(`${key} (${lang}): ${h}`);
		}
		expect(found).toEqual([]);
	});

	it('finds each form a text used for the values, and leaves names, words and model ids alone (control)', () => {
		// Texts as they read before the settings named the tiers.
		const before: ReadonlyArray<[string, 'de' | 'en', string]> = [
			['Background tasks & subagents keep auto-routing across fast/balanced/deep.', 'en', 'values in a slash list'],
			['Welches Sonnet-Modell die Standardstufe (balanced) verwendet.', 'de', 'value in brackets'],
			['Which Sonnet model the balanced tier uses.', 'en', 'value naming a tier'],
			['fast (default)', 'en', 'value marked as the default'],
			['fast (Standard)', 'de', 'value marked as the default'],
			['Allow deep', 'en', 'value after a verb that sets it'],
			['Run on balanced', 'en', 'value after a verb that sets it'],
			['on balanced — deep declined', 'en', 'value after a verb that sets it'],
			['Deep erlauben', 'de', 'stored value in a German text'],
		];
		for (const [text, lang, form] of before) expect(hits(text, lang), text).toContain(form);
		// The other forms each catch.
		const others: ReadonlyArray<[string, 'de' | 'en', string]> = [
			['Gründlichkeit: high', 'de', 'stored value in a German text'],
			['Thoroughness: xhigh', 'en', 'xhigh'],
			['Thinking set to "adaptive".', 'en', 'value in quotes'],
			['Denken: „adaptive“', 'de', 'value in quotes'],
			['Thinking: `disabled`', 'en', 'value in quotes'],
			['Thinking: ‘enabled’', 'en', 'value in quotes'],
			['die balanced Stufe', 'de', 'value naming a tier'],
		];
		for (const [text, lang, form] of others) expect(hits(text, lang), text).toContain(form);
		// Names, a German word, a model's name, a maximum and a model id are not stored values.
		for (const [text, lang] of [
			['Hintergrund-Aufgaben und Subagenten routen weiterhin automatisch über Schnell, Ausgewogen und Tief.', 'de'],
			['Which Sonnet model the default tier, Balanced, uses.', 'en'],
			['Das dauert fast eine Minute.', 'de'],
			['Fast alle Läufe sind fertig.', 'de'],
			['Höchstens {max} Läufe.', 'de'],
			['Der Reranker ruft Anthropic Haiku auf.', 'de'],
			['Wechsle zu Magistral Medium.', 'de'],
			['Beispiel: claude-3-5-sonnet-20241022 oder llama3.2.', 'de'],
			['Per sub-agent (max)', 'en'],
			['A fast answer, a deep look.', 'en'],
		] as const) {
			expect(hits(text, lang), text).toEqual([]);
		}
	});
	it('catches every stored value in every form, and leaves alone only what is named for it (control)', () => {
		// The lists the forms are built from, as defined: a value added there is checked here too, and
		// one lost there fails here.
		expect([...VALUES].sort()).toEqual(['adaptive', 'balanced', 'deep', 'disabled', 'enabled', 'fast', 'haiku', 'high', 'low', 'max', 'medium', 'opus', 'sonnet', 'xhigh']);
		expect([...TIERS].sort()).toEqual(['balanced', 'deep', 'fast']);
		expect([...DE_LEFT_ALONE].sort()).toEqual(['Fast', 'Haiku', 'Max', 'Medium', 'Opus', 'Sonnet', 'fast', 'max']);
		expect([...BRACKETS_LEFT_ALONE]).toEqual(['max']);
		expect(VERBS).toEqual(['on', 'to', 'allow', 'use', 'uses']);
		const cases: string[] = [];
		const caught = (text: string, lang: 'de' | 'en', form: string, yes: boolean): void => {
			cases.push(`${form}: ${text}`);
			if (yes) expect(hits(text, lang), text).toContain(form);
			else expect(hits(text, lang), text).not.toContain(form);
		};
		for (const v of VALUES) {
			for (const w of [v, cap(v)]) caught(`Läuft auf ${w}.`, 'de', 'stored value in a German text', !DE_LEFT_ALONE.has(w));
			caught(`across ${v}/${VALUES[0]} and back`, 'en', 'values in a slash list', true);
			caught(`across ${VALUES[0]}/${v} and back`, 'en', 'values in a slash list', true);
			caught(`Effort (${v})`, 'en', 'value in brackets', !BRACKETS_LEFT_ALONE.has(v));
			caught(`Set to "${v}".`, 'en', 'value in quotes', true);
			caught(`${v} (default)`, 'en', 'value marked as the default', true);
		}
		for (const tier of TIERS) {
			caught(`the ${tier} tier`, 'en', 'value naming a tier', true);
			caught(`die ${tier} Stufe`, 'de', 'value naming a tier', true);
			for (const verb of VERBS) for (const w of [verb, cap(verb)]) caught(`${w} ${tier}`, 'en', 'value after a verb that sets it', true);
		}
		caught('Thoroughness: xhigh', 'en', 'xhigh', true);
		// A count as a control: one case per member of each form.
		expect(cases).toHaveLength(VALUES.length * 7 + TIERS.length * (2 + VERBS.length * 2) + 1);
	});
});
