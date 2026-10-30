import { describe, it, expect, vi, afterEach } from 'vitest';
import { ENV_REGISTRY, ENV_REGISTRY_BY_NAME, envVarRequired, type EnvRegistryRow } from '../src/contract/env-registry.js';
import { CANONICAL_BILLING_TIERS } from '../src/contract/vocab.js';
import { shopifyExchangeSwitchOn } from '../src/tools/builtin/http.js';

/**
 * A var the contract requires on a tier may be absent where a switch says the instance does not
 * use what it feeds (`notRequiredWhenOn`, read by `envVarRequired`). The one such switch today
 * is the Shopify token exchange: on such an instance the control plane may leave out the Mistral
 * block, and the emit side's per-tier presence check has to let it. The rows only permit the
 * omission; nothing here makes the engine avoid Mistral.
 */
const row = (name: string): EnvRegistryRow => {
  const r = ENV_REGISTRY_BY_NAME.get(name);
  if (r === undefined) throw new Error(`no row ${name}`);
  return r;
};

const MISTRAL_BLOCK = ['LYNOX_MODEL_PROFILES_JSON', 'LYNOX_WORKER_PROFILE', 'MISTRAL_API_KEY'];

/** What is wrong with each row's `notRequiredWhenOn`: it must name another `bool` row the control
 *  plane emits, on a `tier` row that requires a tier. */
function switchProblems(rows: readonly EnvRegistryRow[]): string[] {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const problems: string[] = [];
  for (const r of rows) {
    if (r.notRequiredWhenOn === undefined) continue;
    const sw = byName.get(r.notRequiredWhenOn);
    if (r.notRequiredWhenOn === r.name) problems.push(`${r.name}: names itself`);
    else if (sw === undefined) problems.push(`${r.name}: names no row`);
    else if (sw.valueKind !== 'bool') problems.push(`${r.name}: names a ${sw.valueKind} row`);
    else if (sw.emitPolicy === 'operator-only' || sw.emitPolicy === 'denylist') problems.push(`${r.name}: names a switch the control plane does not emit`);
    if (r.emitPolicy !== 'tier') problems.push(`${r.name}: lifted from a '${r.emitPolicy}' row`);
    if ((r.requiredForTier ?? []).length === 0) problems.push(`${r.name}: requires no tier`);
  }
  return problems;
}

describe('env-ABI: a required var a switch lets the control plane leave out', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('the Shopify exchange switch lifts exactly the Mistral block', () => {
    const lifted = ENV_REGISTRY.filter((r) => r.notRequiredWhenOn !== undefined);
    expect(lifted.map((r) => r.name).sort()).toEqual(MISTRAL_BLOCK);
    for (const r of lifted) expect(r.notRequiredWhenOn).toBe('LYNOX_SHOPIFY_EXCHANGE');
  });

  it('every switch names a bool row, on a row that requires a tier', () => {
    expect(switchProblems(ENV_REGISTRY)).toEqual([]);
    const base = { valueKind: 'opaque', emitPolicy: 'tier', engineConsumed: { kind: 'direct', readSite: 'x' } } as const;
    const synthetic = [
      { ...base, name: 'SW_BOOL', valueKind: 'bool', emitPolicy: 'when-true' },
      { ...base, name: 'SW_OPAQUE' },
      { ...base, name: 'SW_OPERATOR', valueKind: 'bool', emitPolicy: 'operator-only' },
      { ...base, name: 'R_OK', requiredForTier: ['managed'], notRequiredWhenOn: 'SW_BOOL' },
      { ...base, name: 'R_NONE', requiredForTier: ['managed'], notRequiredWhenOn: 'SW_MISSING' },
      { ...base, name: 'R_KIND', requiredForTier: ['managed'], notRequiredWhenOn: 'SW_OPAQUE' },
      { ...base, name: 'R_TIER', notRequiredWhenOn: 'SW_BOOL' },
      { ...base, name: 'R_SELF', requiredForTier: ['managed'], notRequiredWhenOn: 'R_SELF' },
      { ...base, name: 'R_UNEMITTED', requiredForTier: ['managed'], notRequiredWhenOn: 'SW_OPERATOR' },
      { ...base, name: 'R_ALWAYS', emitPolicy: 'always', requiredForTier: ['managed'], notRequiredWhenOn: 'SW_BOOL' },
    ] as unknown as EnvRegistryRow[];
    expect(switchProblems(synthetic).map((p) => p.split(':')[0]))
      .toEqual(['R_NONE', 'R_KIND', 'R_TIER', 'R_SELF', 'R_UNEMITTED', 'R_ALWAYS']);
  });

  it('the Mistral block is required on a managed tier while the switch is off, and not once it is on', () => {
    for (const name of MISTRAL_BLOCK) {
      for (const tier of ['managed', 'managed_pro', 'managed_max'] as const) {
        expect(envVarRequired(row(name), tier, {}), `${name} ${tier}`).toBe(true);
        for (const off of ['0', 'false', '', 'TRUE', ' 1', 'yes']) {
          expect(envVarRequired(row(name), tier, { LYNOX_SHOPIFY_EXCHANGE: off }), `${name} ${tier} ${JSON.stringify(off)}`).toBe(true);
        }
        for (const on of ['1', 'true']) {
          expect(envVarRequired(row(name), tier, { LYNOX_SHOPIFY_EXCHANGE: on }), `${name} ${tier} ${on}`).toBe(false);
        }
      }
      expect(envVarRequired(row(name), 'hosted', {})).toBe(false);
    }
  });

  it('the switch lifts nothing else: every other required var stays required with it on', () => {
    const on = { LYNOX_SHOPIFY_EXCHANGE: '1' };
    for (const r of ENV_REGISTRY) {
      if (MISTRAL_BLOCK.includes(r.name)) continue;
      for (const tier of CANONICAL_BILLING_TIERS) {
        expect(envVarRequired(r, tier, on), `${r.name} ${tier}`).toBe((r.requiredForTier ?? []).includes(tier));
      }
    }
  });

  it('reads the switch as the engine does (`shopifyExchangeSwitchOn`)', () => {
    for (const value of ['1', 'true', '0', 'false', '', 'TRUE', ' 1', 'yes', undefined]) {
      vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', value);
      const engineOn = shopifyExchangeSwitchOn();
      const lifted = !envVarRequired(row('MISTRAL_API_KEY'), 'managed', { LYNOX_SHOPIFY_EXCHANGE: value });
      expect(lifted, JSON.stringify(value)).toBe(engineOn);
    }
  });
});
