import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TIER_PRESET_NAMES } from './contract/vocab.js';

/**
 * Covers the mutation that SURVIVED the delta round on 2026-08-10.
 *
 * Making `STRATEGY_CARDS` a `Record<TierPresetName, …>` closed one failure mode —
 * a preset added to the contract without a card is now a build error. It did not
 * close the next one down: add the card, forget the i18n keys, and `t()` returns
 * the KEY (`i18n.svelte.ts`, `translations[key]?.[current] ?? key`). Nothing throws,
 * nothing fails to compile, and the settings page renders `llm.preset.zz_new` to the
 * user as a label. A fallback that never fails is exactly what only a test can hold.
 *
 * READ AS SOURCE, NOT IMPORTED — deliberately. `i18n.svelte.ts` holds the locale in a
 * `$state` rune, so importing it throws `ReferenceError: $state is not defined` under
 * the ROOT vitest config (no Svelte plugin), which is the one CI runs. The first
 * version of this file imported `t()` and was green in the web-ui suite while it broke
 * the root run — caught by the security gate, and the same trap `stores/knowledge-chip
 * .test.ts` documents. Parsing the source is the established way around it here.
 *
 * Both locales, because the fallback is per-locale: a key present in `de` and missing
 * in `en` reads correctly in development and ships broken.
 */
describe('every contract preset has renderable card copy', () => {
	const src = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf-8');
	// The key stem is derived the way LLMSettings derives it: hyphens are not valid
	// in a translation-key segment, so `eu-sovereign` looks up `eu_sovereign`.
	const stem = (name: string): string => name.replace(/-/g, '_');

	/** The `de` and `en` values of a translation entry, or null when the key is absent. */
	function entry(key: string): { de: string; en: string } | null {
		const line = src.split('\n').find((l) => l.includes(`'${key}':`));
		if (!line) return null;
		const de = /\bde:\s*'((?:[^'\\]|\\.)*)'/.exec(line);
		const en = /\ben:\s*'((?:[^'\\]|\\.)*)'/.exec(line);
		return de && en ? { de: de[1]!, en: en[1]! } : null;
	}

	it('name and description exist in de AND en for every contract preset', () => {
		expect(TIER_PRESET_NAMES.length).toBeGreaterThan(0);
		// Guard the guard: if the parser stopped matching the file's shape it would
		// report every key as missing, or (worse, once the loop is empty) nothing.
		expect(entry('llm.preset.custom'), 'parser no longer matches i18n.svelte.ts').not.toBeNull();

		for (const preset of TIER_PRESET_NAMES) {
			for (const suffix of ['', '_desc']) {
				const key = `llm.preset.${stem(preset)}${suffix}`;
				const e = entry(key);
				expect(e, `${key} is missing — the card would render the raw key as its label`).not.toBeNull();
				expect(e!.de.trim().length, `${key}: de is empty`).toBeGreaterThan(0);
				expect(e!.en.trim().length, `${key}: en is empty`).toBeGreaterThan(0);
			}
		}
	});
});
