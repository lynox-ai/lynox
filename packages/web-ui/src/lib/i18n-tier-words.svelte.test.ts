import { describe, it, expect, afterEach } from 'vitest';
import { getLocale, setLocale, t } from './i18n.svelte.js';

// A tier, a thoroughness and a thinking setting carry the names the settings use (`tier-words.ts`),
// in the fixed texts too, not only where a view reads a stored value. This reads every text of
// both languages through `t`, so a text written over several lines or in double quotes is read
// as well, and refuses the stored values in the forms they took when a text named them.

const { default: SOURCE } = (await import('./i18n.svelte.ts?raw')) as { default: string };
const KEYS = [...SOURCE.matchAll(/^\t'([^']+)':\s*\{/gm)].map((m) => m[1]!);

// The stored values: tiers, their older aliases, thoroughness and thinking (`contract/vocab.ts`,
// `STAMP_EFFORTS`, `STAMP_THINKING`). A model's own name (`Sonnet`, `Haiku`, `Magistral Medium`) and
// a model id (`claude-3-5-sonnet-…`) are not stored values: a capital or a hyphen leaves them alone.
const TOKEN = '(?:fast|balanced|deep|haiku|sonnet|opus|low|medium|high|xhigh|max|enabled|adaptive|disabled)';
// In brackets `max` and `high` also mean a maximum or a level (`Per sub-agent (max)`): left out there.
const IN_BRACKETS = '(?:fast|balanced|deep|haiku|sonnet|opus|low|medium|xhigh|enabled|adaptive|disabled)';
const BARE = (re: string): string => `(?<![\\w-])${re}(?![\\w-])`;

const FORMS: ReadonlyArray<[string, RegExp, 'de' | 'en' | 'both']> = [
	// A German text has no English word for a tier: a stored value in it is the value itself, and so
	// is the English word with a capital (`Deep erlauben`). Left out: `fast` and `Fast` are German
	// words, `max` is the name of a placeholder (`{max}`) in many texts.
	['stored value in a German text', new RegExp(BARE('(?:balanced|deep|haiku|sonnet|opus|low|medium|high|xhigh|enabled|adaptive|disabled|Balanced|Deep|Low|High|Adaptive|Enabled|Disabled)')), 'de'],
	// No language has this word.
	['xhigh', new RegExp(BARE('xhigh')), 'both'],
	// The forms a text used for the values: a list with slashes, a value in brackets or in quotes, a
	// value marked as the default, a value naming a tier, and in English a value after a verb that
	// sets it (`Run on balanced`, `Allow deep`).
	['values in a slash list', new RegExp(BARE(`${TOKEN}\\s*/\\s*${TOKEN}`)), 'both'],
	['value in brackets', new RegExp(`\\(\\s*${IN_BRACKETS}\\s*\\)`), 'both'],
	['value in quotes', new RegExp(`[\`"„“'‘]${TOKEN}[\`"“”'’]`), 'both'],
	['value marked as the default', new RegExp(BARE(`${TOKEN}\\s*\\((?:default|Standard)\\)`)), 'both'],
	['value naming a tier', new RegExp(BARE(`(?:fast|balanced|deep)\\s+(?:tier|Stufe)`)), 'both'],
	['value after a verb that sets it', new RegExp(BARE(`(?:[Oo]n|[Tt]o|[Aa]llow|[Uu]se|[Uu]ses)\\s+(?:fast|balanced|deep)`)), 'en'],
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
});
