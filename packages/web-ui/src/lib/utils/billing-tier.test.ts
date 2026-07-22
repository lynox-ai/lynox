import { describe, it, expect } from 'vitest';
import { normalizeBillingTier, isHostedInstance, cpSuppliesLLMKey, keepSettingsItem } from './billing-tier.js';
import { LEGACY_BILLING_TIER_ALIASES, CANONICAL_BILLING_TIERS } from '../contract/vocab.js';

// Behaviour spec for the shim. The old hand-maintained TRUTH table (a third
// copy of the alias rows) is gone: the shared vocabulary now has ONE source of
// truth (`src/contract/vocab.ts`, vendored here byte-identically and guarded by
// `tests/contract-drift.test.ts`), so drift is caught structurally, not by
// duplicated literals. The semantic literals themselves are pinned in core's
// contract tests.
describe('web-ui billing-tier shim', () => {
	it('accepts every canonical tier as itself', () => {
		for (const tier of CANONICAL_BILLING_TIERS) {
			expect(normalizeBillingTier(tier)).toBe(tier);
			expect(isHostedInstance(tier)).toBe(true);
		}
	});

	it('maps every legacy alias to its canonical tier', () => {
		for (const [legacy, canonical] of Object.entries(LEGACY_BILLING_TIER_ALIASES)) {
			expect(normalizeBillingTier(legacy)).toBe(canonical);
			expect(isHostedInstance(legacy)).toBe(true);
		}
	});

	it('cpSuppliesLLMKey is true exactly for the CP-key tiers', () => {
		expect(cpSuppliesLLMKey('managed')).toBe(true);
		expect(cpSuppliesLLMKey('managed_pro')).toBe(true);
		expect(cpSuppliesLLMKey('hosted')).toBe(false); // BYOK
	});

	it('empty / null / unknown values mean self-host', () => {
		for (const input of ['', undefined, null, 'garbage'] as const) {
			expect(normalizeBillingTier(input)).toBeUndefined();
			expect(isHostedInstance(input)).toBe(false);
			expect(cpSuppliesLLMKey(input)).toBe(false);
		}
	});
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
