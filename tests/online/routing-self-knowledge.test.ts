/**
 * Online eval: routing self-knowledge (DEF-routing-self-knowledge).
 *
 * The bug: when the agent PLANNED ("spawne ein Team … verschiedene Modelle"),
 * it hallucinated its own tier→model map (fast/balanced inverted), correct only
 * post-hoc. Root cause was a HARDCODED generic Mistral example in
 * `modelIdentityContext`. The fix injects THIS instance's resolved map.
 *
 * This test proves the OTHER half of the fix from the unit test: the unit test
 * (src/core/prompts.test.ts) proves the RENDER carries the correct map on a
 * mock-green run; THIS test proves the model actually USES that map when it
 * plans a-priori — the distinction fb_skip_ne_pass_green insists on.
 *
 * Gated: real API (Haiku, ~$0.002), NOT part of the default local gate. Runs at
 * `npx vitest run tests/online/` (staging/online), like every sibling here.
 *
 * Cost: ~$0.002.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Agent } from '../../src/core/agent.js';
import { resolveTierModel, setTierSetResolver } from '../../src/core/tier-resolver.js';
import { modelIdentityContext, providerFamilyLabel } from '../../src/core/prompts.js';
import type { TierModelInfo } from '../../src/core/prompts.js';
import type { LLMProvider } from '../../src/types/index.js';
import { getApiKey, hasApiKey, HAIKU } from './setup.js';

const SKIP = !hasApiKey();

// Mirrors Session._identityTierMap — build the map the exact way the runtime does.
const buildTierMap = (base: LLMProvider): TierModelInfo[] =>
  (['fast', 'balanced', 'deep'] as const).map((tier) => {
    const snap = resolveTierModel(tier, base);
    return { tier, modelId: snap.modelId, providerLabel: providerFamilyLabel(snap.provider) };
  });

describe.skipIf(SKIP)('Online: routing self-knowledge (a-priori tier→model plan)', () => {
  let apiKey: string;

  beforeAll(() => {
    apiKey = getApiKey();
    // The literal repro config: an Anthropic-base instance whose `balanced` tier
    // is routed to Mistral via a hybrid tier_set. So fast=claude, balanced=mistral,
    // deep=claude — the exact shape the agent used to invert when planning.
    setTierSetResolver({
      routingMode: 'hybrid',
      tierSet: {
        balanced: {
          provider: 'mistral',
          model_id: 'mistral-large-2512',
          api_key: 'sk-must-never-appear-in-plan',
          api_base_url: 'https://slot-endpoint.example/v1',
        },
      },
    });
  });

  afterAll(() => setTierSetResolver({ routingMode: 'standard', tierSet: null }));

  it('states the resolved tier→model map a-priori (not a hallucinated one)', async () => {
    const base: LLMProvider = 'anthropic';
    const tierMap = buildTierMap(base);
    const expected = {
      fast: resolveTierModel('fast', base).modelId,
      balanced: resolveTierModel('balanced', base).modelId, // = mistral-large-2512
      deep: resolveTierModel('deep', base).modelId,
    };
    // Guard the premise: the repro genuinely crosses providers (else the eval is
    // vacuous — nothing to invert).
    expect(expected.balanced).toBe('mistral-large-2512');
    expect(expected.fast).not.toBe(expected.balanced);

    // Assemble the system prompt the way a real session does: base + the model
    // identity context carrying THIS instance's resolved map.
    const systemPrompt =
      'You are lynox, a business runtime agent.' +
      modelIdentityContext(base, expected.deep, tierMap);

    const agent = new Agent({
      name: 'routing-self-knowledge',
      model: HAIKU,
      apiKey,
      systemPrompt,
      maxIterations: 1,
    });

    // The evidence prompt: force an a-priori statement of the map BEFORE any run,
    // in a strict machine-parseable shape so the assertion is robust to prose.
    const response = await agent.send(
      'Du sollst gleich ein Team von Sub-Agenten spawnen und dabei bewusst ' +
      'verschiedene Modelle nutzen — je einen auf dem `fast`-, `balanced`- und ' +
      '`deep`-Tier. BEVOR du irgendetwas ausführst: nenne für JEDES der drei ' +
      'Tier die exakte, konkrete Modell-ID, die es auf DIESER Instanz verwenden ' +
      'wird. Antworte NUR mit genau drei Zeilen im Format `tier=modell-id` ' +
      '(also `fast=...`, `balanced=...`, `deep=...`), nichts sonst.',
    );

    expect(response).toBeTruthy();
    // Normalize: lowercase, strip backticks/whitespace so `balanced = X` matches.
    const norm = response.toLowerCase().replace(/[`\s]/g, '');

    // The core assertion — the a-priori plan pairs each tier with its RESOLVED id
    // (the map the instance actually runs), and crucially does NOT invert
    // fast/balanced (the original bug put the cheap fast model on `balanced`).
    expect(norm).toContain(`balanced=${expected.balanced.toLowerCase()}`);
    expect(norm).toContain(`fast=${expected.fast.toLowerCase()}`);
    // Not-inverted, stated explicitly: balanced is NOT paired with fast's id.
    expect(norm).not.toContain(`balanced=${expected.fast.toLowerCase()}`);

    // Leak guard end-to-end: the slot credential/endpoint must never surface even
    // when the model is asked to enumerate the map.
    expect(response).not.toContain('sk-must-never-appear-in-plan');
    expect(response).not.toContain('slot-endpoint.example');
  }, 30_000);
});
