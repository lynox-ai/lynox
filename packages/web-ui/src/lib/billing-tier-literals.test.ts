import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_BILLING_TIERS } from './contract/vocab.js';

/**
 * "Does the control plane supply the LLM key?" has one answer: `cpSuppliesLLMKey`
 * from the contract. Components used to spell the set out themselves
 * (`managed === 'managed' || managed === 'managed_pro' || managed === 'eu'`), in nine
 * places, so adding a billing tier meant finding every copy — and a missed copy made
 * the new tier look like a customer-key instance: provider picker, BYOK setup path.
 *
 * This refuses a comparison of a tier-holding variable against a CP-key tier literal
 * anywhere in `src/` outside the vendored contract. `'hosted'` stays allowed: it is
 * the one customer-key tier, and comparing a normalized value against it is the
 * question "BYOK or not", not an enumeration of the CP-key set.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACT_DIR = join(ROOT, 'lib', 'contract');

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (path !== CONTRACT_DIR) out.push(...sources(path));
		} else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
			out.push(path);
		}
	}
	return out;
}

const ENUMERATION =
	/\b(?:managed|managedMode|managedTier)\s*[!=]==?\s*'(?:managed|managed_pro|managed_max|eu|starter)'/;

describe('billing tier is asked through the contract, never spelled out', () => {
	it('no component compares a tier value against a CP-key tier literal', () => {
		const files = sources(ROOT);
		// Positive control: the walk must reach the components it guards, or an empty
		// list would pass this test for the wrong reason.
		expect(files.some((f) => f.endsWith('SetupBanner.svelte'))).toBe(true);
		const hits: string[] = [];
		for (const file of files) {
			readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
				if (ENUMERATION.test(line)) hits.push(`${file.slice(ROOT.length)}:${i + 1}: ${line.trim()}`);
			});
		}
		expect(hits, 'use cpSuppliesLLMKey / normalizeBillingTier from utils/billing-tier').toEqual([]);
	});

	it('the pattern catches the form it exists for', () => {
		expect(ENUMERATION.test("managed = body.managed === 'managed' || body.managed === 'managed_pro';")).toBe(true);
		expect(ENUMERATION.test("{#if managedMode !== 'managed_max'}")).toBe(true);
		expect(ENUMERATION.test("{#if managed === 'hosted'}")).toBe(false);
	});

	it('every canonical tier has an account label in both locales', () => {
		// Read as source: importing i18n.svelte.ts throws under the root vitest config
		// (see preset-cards-i18n.test.ts). A missing key renders the key itself.
		const src = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf-8');
		for (const tier of CANONICAL_BILLING_TIERS) {
			const line = src.split('\n').find((l) => l.includes(`'account.billing.tier.${tier}':`));
			expect(line, tier).toBeDefined();
			expect(line).toMatch(/de: '[^']+'/);
			expect(line).toMatch(/en: '[^']+'/);
		}
	});
});
