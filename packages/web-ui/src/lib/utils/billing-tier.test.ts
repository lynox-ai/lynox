import { describe, it, expect } from 'vitest';
import { normalizeBillingTier, isHostedInstance, cpSuppliesLLMKey, keepSettingsItem } from './billing-tier.js';

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

describe('keepSettingsItem (shared SettingsIndex + CommandPalette tier gate)', () => {
	// managed: true = managed instance, false = self-host, null = not yet probed.
	it('always shows a flagless item on every tier (incl. unprobed)', () => {
		for (const managed of [true, false, null] as const) {
			expect(keepSettingsItem({}, managed)).toBe(true);
		}
	});

	it('selfHostOnly: visible only on self-host, hidden on managed AND while unprobed', () => {
		expect(keepSettingsItem({ selfHostOnly: true }, false)).toBe(true);
		expect(keepSettingsItem({ selfHostOnly: true }, true)).toBe(false);
		expect(keepSettingsItem({ selfHostOnly: true }, null)).toBe(false); // no flash before /api/config
	});

	it('managedOnly: visible only on managed, hidden on self-host AND while unprobed', () => {
		expect(keepSettingsItem({ managedOnly: true }, true)).toBe(true);
		expect(keepSettingsItem({ managedOnly: true }, false)).toBe(false);
		expect(keepSettingsItem({ managedOnly: true }, null)).toBe(false); // no flash before /api/config
	});

	it('both flags set hides the item on every concrete tier (safe default)', () => {
		expect(keepSettingsItem({ selfHostOnly: true, managedOnly: true }, true)).toBe(false);
		expect(keepSettingsItem({ selfHostOnly: true, managedOnly: true }, false)).toBe(false);
		expect(keepSettingsItem({ selfHostOnly: true, managedOnly: true }, null)).toBe(false);
	});
});
