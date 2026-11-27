import { describe, it, expect, afterEach } from 'vitest';
import { getLocale, setLocale, t } from './i18n.svelte.js';

// A tier, a thoroughness and a thinking setting carry the names the settings use (`tier-words.ts`),
// in the fixed texts too, not only where a view reads a stored value. This reads every text of
// both languages through `t`, so a text written over several lines or in double quotes is read
// as well, and refuses the stored values in the forms they took when a text named them.

const { default: SOURCE } = (await import('./i18n.svelte.ts?raw')) as { default: string };
const KEYS = [...SOURCE.matchAll(/^\t'([^']+)':\s*\{/gm)].map((m) => m[1]!);

// The stored values: tiers, their older aliases, thoroughness and thinking (`contract/vocab.ts`,
// `STAMP_EFFORTS`, `STAMP_THINKING`). A model's own name (`Sonnet`, `claude-3-5-sonnet-…`) is not
// a stored tier: capitalised, or inside a model id, it is left alone.
const TOKEN = '(?:fast|balanced|deep|haiku|sonnet|opus|low|medium|high|xhigh|max|enabled|adaptive|disabled)';
const BARE = (re: string): string => `(?<![\\w-])${re}(?![\\w-])`;

const FORMS: ReadonlyArray<[string, RegExp, 'de' | 'en' | 'both']> = [
	// A German text has no English word for a tier: a stored value in it is the value itself. `fast`,
	// `max` and `low`/`high` are left out; `fast` is a German word, `max.` an abbreviation.
	['stored value in a German text', new RegExp(BARE('(?:balanced|deep|haiku|sonnet|opus|medium|xhigh|enabled|adaptive|disabled)')), 'de'],
	// No language has this word.
	['xhigh', new RegExp(BARE('xhigh')), 'both'],
	// The forms a text used for the values: a list with slashes, a value in brackets or in quotes,
	// a value naming a tier.
	['values in a slash list', new RegExp(BARE(`${TOKEN}\\s*/\\s*${TOKEN}`)), 'both'],
	['value in brackets', new RegExp(`\\(\\s*${TOKEN}\\s*\\)`), 'both'],
	['value in quotes', new RegExp(`[\`"„“'‘]${TOKEN}[\`"“”'’]`), 'both'],
	['value naming a tier', new RegExp(BARE(`(?:fast|balanced|deep)\\s+(?:tier|Stufe)`)), 'both'],
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

	it('finds each form a text used for the values, and leaves names and model ids alone (control)', () => {
		// The texts as they read before the settings named the tiers.
		expect(hits('Background tasks & subagents keep auto-routing across fast/balanced/deep.', 'en')).toEqual(['values in a slash list']);
		expect(hits('Welches Sonnet-Modell die Standardstufe (balanced) verwendet.', 'de')).toEqual(['stored value in a German text', 'value in brackets']);
		expect(hits('Which Sonnet model the balanced tier uses.', 'en')).toEqual(['value naming a tier']);
		expect(hits('Gründlichkeit: xhigh', 'de')).toEqual(['stored value in a German text', 'xhigh']);
		expect(hits('Thinking set to "adaptive".', 'en')).toEqual(['value in quotes']);
		// Names, a German word, a model's name and a model id are not stored values.
		for (const [text, lang] of [
			['Hintergrund-Aufgaben und Subagenten routen weiterhin automatisch über Schnell, Ausgewogen und Tief.', 'de'],
			['Which Sonnet model the default tier, Balanced, uses.', 'en'],
			['Das dauert fast eine Minute.', 'de'],
			['Beispiel: claude-3-5-sonnet-20241022 oder llama3.2.', 'de'],
			['A fast answer, a deep look.', 'en'],
		] as const) {
			expect(hits(text, lang), text).toEqual([]);
		}
	});
});
