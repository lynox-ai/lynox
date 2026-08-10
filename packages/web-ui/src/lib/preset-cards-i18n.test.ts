import { describe, it, expect } from 'vitest';
import { t, setLocale } from './i18n.svelte.js';
import { TIER_PRESET_NAMES } from './contract/vocab.js';

/**
 * Covers the mutation that SURVIVED the delta round on 2026-08-10.
 *
 * Making `STRATEGY_CARDS` a `Record<TierPresetName, …>` closed one failure mode —
 * a preset added to the contract without a card is now a build error. It did not
 * close the next one down: add the card, forget the i18n keys, and `t()` returns
 * the KEY (`i18n.svelte.ts:2162`, `translations[key]?.[current] ?? key`). Nothing
 * throws, nothing fails to compile, and the settings page renders a card labelled
 * `llm.preset.zz_new` to the user. A fallback that never fails is exactly the kind
 * of thing that only a test can hold.
 *
 * Both locales, because the fallback is per-locale: a key present in `de` and
 * missing in `en` reads correctly in development here and ships broken.
 *
 * The key STEM is derived the same way the component does it (hyphens → underscore),
 * so this test and `PRESET_CARDS` cannot disagree about what to look up.
 */
describe('every contract preset has renderable card copy', () => {
	const stem = (name: string): string => name.replace(/-/g, '_');

	it('name and description resolve in de AND en — never the raw key', () => {
		expect(TIER_PRESET_NAMES.length).toBeGreaterThan(0);
		for (const locale of ['de', 'en'] as const) {
			setLocale(locale);
			for (const preset of TIER_PRESET_NAMES) {
				for (const suffix of ['', '_desc']) {
					const key = `llm.preset.${stem(preset)}${suffix}`;
					const out = t(key);
					expect(out, `${locale}: ${key} falls back to the raw key — the card would render it as its label`).not.toBe(key);
					expect(out.trim().length, `${locale}: ${key} is empty`).toBeGreaterThan(0);
				}
			}
		}
	});
});
