/**
 * A dash-dated snapshot of a registered model (`claude-fable-5-20260101`) resolves to that
 * model's registry entry (`models.ts › modelCapability`), so pricing, the output ceiling, the
 * budget guard, the deep-band check and the tier ceiling read the same model the undated id
 * names. An id whose undated form is not registered stays unknown.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { getPricing, hasKnownPricing, _resetOverridePricingForTests } from './pricing.js';
import { CostGuard } from './cost-guard.js';
import {
  MODEL_CAPABILITIES, getDefaultMaxTokens, modelCapability, modelIdExceedsMaxTier, modelIdIsDeepBand, undatedModelId,
} from '../types/models.js';

const DATE = '-20260101';
const turn = { input_tokens: 100_000, output_tokens: 100_000 } as BetaUsage;

/** How many turns of `turn` a $5 budget lets through on `model` before it reports exceeded. */
function turnsToLimit(model: string): number {
  const guard = new CostGuard({ maxBudgetUSD: 5 }, model);
  for (let n = 1; n <= 10; n++) if (guard.recordTurn(turn)) return n;
  return Infinity;
}

afterEach(() => _resetOverridePricingForTests(null));

describe('a dash-dated id of a registered model', () => {
  it('is priced as the model: Fable no longer under, Mistral no longer over the fallback', () => {
    // Fable is above the fallback rate, so the fallback halved it.
    expect(getPricing(`claude-fable-5${DATE}`)).toEqual(getPricing('claude-fable-5'));
    expect(getPricing('claude-fable-5').output).toBeGreaterThan(getPricing('not-a-model').output);
    // Mistral Large is far below it, so the fallback overstated it about tenfold.
    expect(getPricing(`mistral-large-2512${DATE}`)).toEqual(getPricing('mistral-large-2512'));
    expect(getPricing('mistral-large-2512').output).toBeLessThan(getPricing('not-a-model').output);
    expect(hasKnownPricing(`claude-fable-5${DATE}`)).toBe(true);
  });

  it('gets the model\'s output ceiling, with `[1m]` behind the date as well', () => {
    expect(getDefaultMaxTokens(`claude-opus-4-6${DATE}`)).toBe(getDefaultMaxTokens('claude-opus-4-6'));
    expect(getDefaultMaxTokens('claude-opus-4-6')).not.toBe(getDefaultMaxTokens('not-a-model'));
    expect(modelCapability(`claude-opus-4-6${DATE}[1m]`)).toBe(MODEL_CAPABILITIES['claude-opus-4-6']);
  });

  it('reaches the budget limit after as many turns as the undated id', () => {
    expect(turnsToLimit('claude-fable-5')).toBe(1);
    expect(turnsToLimit(`claude-fable-5${DATE}`)).toBe(1);
    expect(turnsToLimit('claude-fable-5@20260101')).toBe(1);
  });

  it('is deep for the deep-band check exactly when the registry resolves it to a deep model', () => {
    expect(modelIdIsDeepBand(`claude-opus-4-6${DATE}`)).toBe(true);
    expect(modelIdIsDeepBand(`claude-fable-5${DATE}`)).toBe(true);
    expect(modelIdIsDeepBand(`not-a-model${DATE}`)).toBe(false);
    expect(modelIdIsDeepBand(`claude-sonnet-5${DATE}`)).toBe(false);
    // A `[1m]` or a Vertex date before the dash date is removed as well.
    expect(modelIdIsDeepBand(`claude-opus-4-6[1m]${DATE}`)).toBe(true);
    expect(modelIdIsDeepBand(`claude-opus-4-6@20260101${DATE}`)).toBe(true);
    expect(getPricing(`claude-opus-4-6[1m]${DATE}`)).toEqual(getPricing('claude-opus-4-6'));
    // `[1m]` before a Vertex date survives one normalization (the `[1m]` is no longer last
    // when it runs); the second normalization after the date step removes it.
    expect(modelCapability('claude-opus-4-6[1m]@20260101')).toBe(MODEL_CAPABILITIES['claude-opus-4-6']);
  });

  it('passes a tier ceiling it is under: a dated balanced model is no longer read as deep', () => {
    // This is the half of the change that allows more: before it, the dated id was unknown,
    // and unknown counts as deep under a ceiling.
    expect(modelIdExceedsMaxTier(`claude-sonnet-5${DATE}`, 'balanced')).toBe(false);
    expect(modelIdExceedsMaxTier(`claude-opus-4-6${DATE}`, 'balanced')).toBe(true);
    expect(modelIdExceedsMaxTier(`not-a-model${DATE}`, 'balanced')).toBe(true);
  });

  it('takes an operator price set for the model', () => {
    _resetOverridePricingForTests({ 'claude-fable-5': { input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 } });
    expect(getPricing(`claude-fable-5${DATE}`)).toEqual({ input: 1, output: 2, cacheWrite: 1, cacheRead: 0.1 });
    expect(getPricing(`claude-fable-5${DATE}`)).toEqual(getPricing('claude-fable-5'));
  });

  it('takes an operator price for a model the registry does not know, and counts it as priced', () => {
    const local = { input: 0.1, output: 0.2, cacheWrite: 0.1, cacheRead: 0.01 };
    _resetOverridePricingForTests({ 'my-local-model': local });
    expect(getPricing(`my-local-model${DATE}`)).toEqual(local);
    expect(hasKnownPricing(`my-local-model${DATE}`)).toBe(true);
    expect(hasKnownPricing(`other-local-model${DATE}`)).toBe(false);
  });
});

describe('what stays as it was', () => {
  it('an 8-digit ending on an id that is not registered stays at the fallback', () => {
    expect(modelCapability(`not-a-model${DATE}`)).toBeUndefined();
    expect(getPricing(`not-a-model${DATE}`)).toEqual(getPricing('not-a-model'));
    expect(hasKnownPricing(`not-a-model${DATE}`)).toBe(false);
  });

  it('a registered dated id keeps its own entry, and its own price over an operator price for its undated form', () => {
    expect(modelCapability('claude-haiku-4-5-20251001')).toBe(MODEL_CAPABILITIES['claude-haiku-4-5-20251001']);
    const registered = getPricing('claude-haiku-4-5-20251001');
    _resetOverridePricingForTests({ 'claude-haiku-4-5': { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 } });
    expect(getPricing('claude-haiku-4-5-20251001')).toEqual(registered);
    // The undated id and a dated id the registry does not have take the operator's price.
    expect(getPricing('claude-haiku-4-5').input).toBe(9);
    expect(getPricing(`claude-haiku-4-5${DATE}`).input).toBe(9);
  });

  it('only a dash and exactly eight digits at the end count as a date', () => {
    expect(undatedModelId(`claude-fable-5${DATE}`)).toBe('claude-fable-5');
    expect(undatedModelId('claude-fable-5-2026010')).toBe('claude-fable-5-2026010');
    expect(undatedModelId('claude-fable-5-202601011')).toBe('claude-fable-5-202601011');
    expect(undatedModelId('mistral-large-2512')).toBe('mistral-large-2512');
    expect(modelCapability('claude-fable-5-2026010')).toBeUndefined();
  });
});
