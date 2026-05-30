import { describe, it, expect } from 'vitest';
import { isProviderTileLocked, type TileLockInput } from './llm-tile-lock.js';

const base: TileLockInput = {
	providerEnvPinned: false,
	providerLocked: false,
	customEndpointsLocked: false,
	isActive: false,
	requiresBaseUrl: false,
};

describe('isProviderTileLocked', () => {
	it('leaves curated tiles interactive in the default (unlocked) case', () => {
		expect(isProviderTileLocked(base)).toBe(false);
		expect(isProviderTileLocked({ ...base, isActive: true })).toBe(false);
	});

	describe('env-pinned (LYNOX_LLM_PROVIDER) — the staging-walk finding', () => {
		it('disables EVERY tile, including the active one (active detection is unreliable)', () => {
			expect(isProviderTileLocked({ ...base, providerEnvPinned: true, isActive: false })).toBe(true);
			expect(isProviderTileLocked({ ...base, providerEnvPinned: true, isActive: true })).toBe(true);
		});
		it('disables free-text and curated tiles alike', () => {
			expect(isProviderTileLocked({ ...base, providerEnvPinned: true, requiresBaseUrl: true })).toBe(true);
			expect(isProviderTileLocked({ ...base, providerEnvPinned: true, requiresBaseUrl: false })).toBe(true);
		});
	});

	describe('operator hard-lock (locks.provider)', () => {
		it('disables non-active tiles', () => {
			expect(isProviderTileLocked({ ...base, providerLocked: true, isActive: false })).toBe(true);
		});
		it('keeps the active tile selectable', () => {
			expect(isProviderTileLocked({ ...base, providerLocked: true, isActive: true })).toBe(false);
		});
	});

	describe('managed custom-endpoints lock', () => {
		it('disables only free-text endpoint tiles', () => {
			expect(isProviderTileLocked({ ...base, customEndpointsLocked: true, requiresBaseUrl: true })).toBe(true);
		});
		it('keeps curated (no base-url) tiles switchable', () => {
			expect(isProviderTileLocked({ ...base, customEndpointsLocked: true, requiresBaseUrl: false })).toBe(false);
		});
	});
});
