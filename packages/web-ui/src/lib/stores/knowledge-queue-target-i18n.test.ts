import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The keys `approveTargetLabel` returns must EXIST, in both locales.
 *
 * `t()` returns the key itself on a miss (`i18n.svelte.ts`, `translations[key]?.[current]
 * ?? key`), so a missing key does not throw, does not fail to compile, and renders
 * `knowledge.queue.target_new` to the reviewer where "will be created" belongs — on the
 * surface whose entire job is telling them what approve will do. Nothing else can hold a
 * fallback that never fails; the same reasoning and shape as `preset-cards-i18n.test.ts`.
 *
 * Source is READ, not imported: `i18n.svelte.ts` holds the locale in a `$state` rune and
 * importing it throws under the ROOT vitest config, which is the one CI runs.
 */
describe('the approve-target labels have copy in both locales', () => {
	const i18nSrc = readFileSync(fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)), 'utf-8');
	const moduleSrc = readFileSync(fileURLToPath(new URL('./knowledge-queue-target.ts', import.meta.url)), 'utf-8');

	function entry(key: string): { de: string; en: string } | null {
		const line = i18nSrc.split('\n').find((l) => l.includes(`'${key}':`));
		if (!line) return null;
		const de = /\bde:\s*'((?:[^'\\]|\\.)*)'/.exec(line);
		const en = /\ben:\s*'((?:[^'\\]|\\.)*)'/.exec(line);
		return de && en ? { de: de[1]!, en: en[1]! } : null;
	}

	it('every key the module emits resolves in de AND en', () => {
		// The keys are collected FROM the module, so a fourth arm added later is covered
		// without editing this test — the failure mode being guarded is "added the arm,
		// forgot the copy".
		const keys = [...moduleSrc.matchAll(/'(knowledge\.queue\.target_[a-z_]+)'/g)].map((m) => m[1]!);
		const unique = [...new Set(keys)];
		// Guard the guard, twice: a parser that stopped matching would report every key
		// missing, and a collector that stopped matching would assert over nothing.
		expect(unique.length, 'no target keys found in the module — the collector regex drifted').toBeGreaterThanOrEqual(3);
		expect(entry('knowledge.queue.approve'), 'parser no longer matches i18n.svelte.ts').not.toBeNull();

		for (const key of unique) {
			const e = entry(key);
			expect(e, `${key} is missing from i18n.svelte.ts`).not.toBeNull();
			expect(e!.de.length, `${key} has no German copy`).toBeGreaterThan(0);
			expect(e!.en.length, `${key} has no English copy`).toBeGreaterThan(0);
		}
	});
});
