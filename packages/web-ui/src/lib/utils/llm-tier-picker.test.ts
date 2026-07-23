// === Hybrid per-tier picker helper tests ===
//
// Pins the behavior that lets a free-text tile with pinned `tier_models`
// (Fireworks) join the per-tier editor without touching the tile's free-text
// semantics, and the managed gating that keeps the option honest (offered only
// when the CP demonstrably backs it — otherwise its save could only 403).

import { describe, it, expect } from 'vitest';
import {
	tierPickerModels,
	defaultTierModelId,
	cpBacksTierModels,
	isHybridTierOption,
	presetTierSeed,
	type TierPickerEntry,
	type PresetInfoLike,
} from './llm-tier-picker.js';

const GLM = 'accounts/fireworks/models/glm-5p2';
const DEEPSEEK = 'accounts/fireworks/models/deepseek-v4-pro';

const anthropicLike: TierPickerEntry = {
	provider: 'anthropic',
	models: [
		{ id: 'claude-haiku-4-5-20251001', tier: 'fast', label: 'Haiku 4.5' },
		{ id: 'claude-sonnet-4-6', tier: 'balanced', label: 'Sonnet 4.6' },
		{ id: 'claude-opus-4-6', tier: 'deep', label: 'Opus 4.6' },
	],
};

const mistralLike: TierPickerEntry = {
	provider: 'openai',
	models: [
		{ id: 'mistral-medium-2604', tier: 'deep', label: 'Mistral Medium 3.5' },
		{ id: 'ministral-8b-2512', tier: 'fast', label: 'Ministral 8B' },
	],
};

const fireworksLike: TierPickerEntry = {
	provider: 'openai',
	models: [],   // free-text tile — MUST stay empty (core catalog contract)
	tier_models: [
		{ id: GLM, label: 'GLM 5.2', pricing: { input: 1.40, output: 4.40 } },
		{ id: DEEPSEEK, label: 'DeepSeek v4 Pro', pricing: { input: 1.74, output: 3.48 } },
	],
};

const freeTextLike: TierPickerEntry = { provider: 'openai', models: [] };
const vertexLike: TierPickerEntry = { provider: 'vertex', models: [{ id: 'claude-sonnet-4-6', tier: 'balanced', label: 'Sonnet 4.6 (Vertex)' }] };

// The GET /api/config `available_tier_presets` shape (server-computed with the
// same loader hardening that keeps/drops slots at config-load).
const efficientAvailable: Record<string, PresetInfoLike> = {
	efficient: {
		available: true,
		tiers: [
			{ tier: 'fast', model_id: 'ministral-8b-2512' },
			{ tier: 'balanced', model_id: 'mistral-medium-2604' },
			{ tier: 'deep', model_id: GLM },
		],
	},
};
const efficientUnavailable: Record<string, PresetInfoLike> = {
	efficient: { ...efficientAvailable['efficient']!, available: false },
};

describe('tierPickerModels', () => {
	it('a tiered catalog wins — tier_models is only the free-text-tile source', () => {
		expect(tierPickerModels(anthropicLike)).toBe(anthropicLike.models);
	});
	it('falls back to tier_models when models is the free-text []', () => {
		expect(tierPickerModels(fireworksLike).map((m) => m.id)).toEqual([GLM, DEEPSEEK]);
	});
	it('yields [] for a fully free-text tile', () => {
		expect(tierPickerModels(freeTextLike)).toEqual([]);
	});
});

describe('defaultTierModelId', () => {
	it('prefers the model tagged with the tier', () => {
		expect(defaultTierModelId(anthropicLike, 'deep')).toBe('claude-opus-4-6');
		expect(defaultTierModelId(mistralLike, 'fast')).toBe('ministral-8b-2512');
	});
	it('falls back to the first model when no tier tag matches', () => {
		// Mistral fixture has no balanced-tagged model → first overall.
		expect(defaultTierModelId(mistralLike, 'balanced')).toBe('mistral-medium-2604');
	});
	it('tier_models entries (no tier tags — preset-slot models) default to the first entry for EVERY tier', () => {
		expect(defaultTierModelId(fireworksLike, 'fast')).toBe(GLM);
		expect(defaultTierModelId(fireworksLike, 'balanced')).toBe(GLM);
		expect(defaultTierModelId(fireworksLike, 'deep')).toBe(GLM);
	});
	it("returns '' when the entry offers nothing", () => {
		expect(defaultTierModelId(freeTextLike, 'deep')).toBe('');
	});
});

describe('cpBacksTierModels', () => {
	it('true when an AVAILABLE preset routes a slot through one of the entry models', () => {
		expect(cpBacksTierModels(fireworksLike, efficientAvailable)).toBe(true);
	});
	it('false when the only routing preset is unavailable (flag/key not provisioned)', () => {
		expect(cpBacksTierModels(fireworksLike, efficientUnavailable)).toBe(false);
	});
	it('false when no preset routes through the entry at all', () => {
		const unrelated: Record<string, PresetInfoLike> = {
			'max-quality': { available: true, tiers: [{ tier: 'deep', model_id: 'claude-fable-5' }] },
		};
		expect(cpBacksTierModels(fireworksLike, unrelated)).toBe(false);
	});
	it('false for an entry without tier_models (nothing to back)', () => {
		expect(cpBacksTierModels(freeTextLike, efficientAvailable)).toBe(false);
	});
});

describe('isHybridTierOption', () => {
	const selfHost = { cpSuppliesKey: false, availablePresets: {} };

	it('vertex is never offered (retired in-product)', () => {
		expect(isHybridTierOption(vertexLike, selfHost)).toBe(false);
	});
	it('tiered-catalog entries are always offered', () => {
		expect(isHybridTierOption(anthropicLike, selfHost)).toBe(true);
		expect(isHybridTierOption(mistralLike, { cpSuppliesKey: true, availablePresets: {} })).toBe(true);
	});
	it('a tier_models tile is offered on self-host/BYOK regardless of presets', () => {
		expect(isHybridTierOption(fireworksLike, selfHost)).toBe(true);
	});
	it('on a CP-supplied instance a tier_models tile needs the backing evidence', () => {
		expect(isHybridTierOption(fireworksLike, { cpSuppliesKey: true, availablePresets: efficientAvailable })).toBe(true);
		expect(isHybridTierOption(fireworksLike, { cpSuppliesKey: true, availablePresets: efficientUnavailable })).toBe(false);
		expect(isHybridTierOption(fireworksLike, { cpSuppliesKey: true, availablePresets: {} })).toBe(false);
	});
	it('a fully free-text tile is never offered (no per-tier free-text field)', () => {
		expect(isHybridTierOption(freeTextLike, selfHost)).toBe(false);
	});
});

describe('presetTierSeed', () => {
	const options = [
		{ key: 'anthropic', entry: anthropicLike },
		{ key: 'mistral', entry: mistralLike },
		{ key: 'fireworks', entry: fireworksLike },
	];

	it('maps every resolvable preset tier to its provider option + model — Fireworks via tier_models', () => {
		expect(presetTierSeed(efficientAvailable['efficient'], options)).toEqual({
			fast: { catalogKey: 'mistral', modelId: 'ministral-8b-2512' },
			balanced: { catalogKey: 'mistral', modelId: 'mistral-medium-2604' },
			deep: { catalogKey: 'fireworks', modelId: GLM },
		});
	});

	it('omits a tier whose model no offered option carries (caller default covers it)', () => {
		const preset: PresetInfoLike = {
			available: true,
			tiers: [
				{ tier: 'fast', model_id: 'ministral-8b-2512' },
				{ tier: 'deep', model_id: 'some-unknown-model' },
			],
		};
		expect(presetTierSeed(preset, options)).toEqual({
			fast: { catalogKey: 'mistral', modelId: 'ministral-8b-2512' },
		});
	});

	it('ignores tier names outside the editor bands and yields {} without a preset', () => {
		const preset: PresetInfoLike = { available: true, tiers: [{ tier: 'ultra', model_id: GLM }] };
		expect(presetTierSeed(preset, options)).toEqual({});
		expect(presetTierSeed(undefined, options)).toEqual({});
	});
});
