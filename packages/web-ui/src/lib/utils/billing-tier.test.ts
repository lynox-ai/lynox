import { describe, it, expect } from 'vitest';
import { normalizeBillingTier, isHostedInstance, cpSuppliesLLMKey } from './billing-tier.js';

// Drift guard: this web-ui mirror must agree with the control-plane's canonical
// billing-tier module and the core-side mirror. Same TRUTH rows in all three.
const TRUTH: Array<[string | undefined | null, string | undefined, boolean, boolean]> = [
	// input,        canonical,     isHosted, cpSuppliesLLMKey
	['starter', 'hosted', true, false],
	['hosted', 'hosted', true, false],
	['eu', 'managed', true, true],
	['managed', 'managed', true, true],
	['managed_pro', 'managed_pro', true, true],
	['', undefined, false, false],
	[undefined, undefined, false, false],
	[null, undefined, false, false],
	['garbage', undefined, false, false],
];

describe('web-ui billing-tier mirror', () => {
	for (const [input, canonical, hosted, supplies] of TRUTH) {
		it(`tier ${JSON.stringify(input)}`, () => {
			expect(normalizeBillingTier(input)).toBe(canonical);
			expect(isHostedInstance(input)).toBe(hosted);
			expect(cpSuppliesLLMKey(input)).toBe(supplies);
		});
	}
});
