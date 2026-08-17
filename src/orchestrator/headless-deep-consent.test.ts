import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolEntry, LynoxUserConfig } from '../types/index.js';
import { getModelId } from '../types/index.js';
import { resolveRunModel } from '../core/tier-resolver.js';

// The headless deep-consent parity for pipeline steps — the spawn-side D2
// clamp applied at the step-resolution sites (spawnInline for run_workflow
// inline steps, spawnViaAgent for saved/agent steps, resolveModelForCost for
// the budget precheck + step-row stamp). A consent boundary that a sibling
// fan-out tool bypasses is not a boundary, so these tests pin the REQUEST
// rewrite (not a post-hoc substitution — the ceiling + blocklist must
// re-apply to the clamped request), both wiring sites, and the empty-string
// no-override path.

const mockSend = vi.fn().mockResolvedValue('mock result');

vi.mock('../core/agent.js', () => ({
  Agent: vi.fn().mockImplementation(function (this: { send: typeof mockSend; abort: ReturnType<typeof vi.fn>; noteUntrustedData: ReturnType<typeof vi.fn>; restoreConversationTaint: ReturnType<typeof vi.fn> }) {
    this.send = mockSend;
    this.abort = vi.fn();
    this.noteUntrustedData = vi.fn();
    this.restoreConversationTaint = vi.fn();
  }),
}));

const mockGetRole = vi.fn().mockReturnValue(undefined);
vi.mock('../core/roles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/roles.js')>();
  return {
    ...actual,
    getRole: (...args: unknown[]) => mockGetRole(...args),
    getRoleNames: () => ['researcher', 'creator', 'operator', 'collector'],
  };
});

import { Agent } from '../core/agent.js';
import { headlessStepModelOverride, spawnInline, spawnViaAgent } from './runtime-adapter.js';
import type { AgentDef, ManifestStep } from '../types/orchestration.js';

const mockConfig = { api_key: 'test-key' } as unknown as LynoxUserConfig;

const mockParentTools: ToolEntry[] = [
  { definition: { name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } } as ToolEntry['definition'], handler: async () => 'content' },
  { definition: { name: 'write_file', description: 'Write a file', input_schema: { type: 'object' } } as ToolEntry['definition'], handler: async () => 'ok' },
];

const PROVIDER = 'anthropic' as const;

function agentModelOfCall(call: number): string {
  const calls = vi.mocked(Agent).mock.calls;
  expect(calls.length).toBeGreaterThan(call);
  const cfg = calls[call]![0] as unknown as Record<string, unknown>;
  return cfg['model'] as string;
}

beforeEach(() => {
  vi.mocked(Agent).mockClear();
  mockGetRole.mockClear();
  mockGetRole.mockReturnValue(undefined);
});

describe('headlessStepModelOverride (pure)', () => {
  it('rewrites a requested deep tier to balanced when autonomous', () => {
    expect(headlessStepModelOverride('deep', 'fast', 'autonomous')).toBe('balanced');
  });

  it('rewrites the legacy deep alias (opus) to balanced when autonomous', () => {
    expect(headlessStepModelOverride('opus', 'fast', 'autonomous')).toBe('balanced');
  });

  it('rewrites a deep step default reaching an undeclared step when autonomous', () => {
    expect(headlessStepModelOverride(undefined, 'deep', 'autonomous')).toBe('balanced');
  });

  it('treats model:"" as no override — a deep default still clamps (the empty-string bypass)', () => {
    expect(headlessStepModelOverride('', 'deep', 'autonomous')).toBe('balanced');
  });

  it('refuses a deep-band raw model id when autonomous (cannot be substituted)', () => {
    const pinned = getModelId('deep', PROVIDER); // a registered deep-band id
    expect(() => headlessStepModelOverride(pinned, 'fast', 'autonomous'))
      .toThrow(/cannot run autonomously without explicit consent/);
  });

  it('a control-char-poisoned id never reaches the refusal, so it passes through unchanged', () => {
    // This replaces a test that could not fail. It read:
    //   try { headlessStepModelOverride(poisoned, …); expect.unreachable('must throw'); }
    //   catch (err) { expect((err as Error).message).not.toContain('\n'); }
    // `expect.unreachable`'s OWN error landed in that same catch, and "must
    // throw" contains no newline — so the assertion passed, the refusal branch
    // was never executed, and deleting the sanitizer left the suite green.
    //
    // The honest fact: refusal requires a REGISTERED id (optionally date-
    // suffixed), and no registry literal contains a control character, so the
    // poisoned id takes the unknown-band pass-through like any local pin.
    const poisoned = getModelId('deep', PROVIDER) + '\nX-Injected: 1';
    expect(() => headlessStepModelOverride(poisoned, 'fast', 'autonomous')).not.toThrow();
    expect(headlessStepModelOverride(poisoned, 'fast', 'autonomous')).toBe(poisoned);
  });

  it('the refused-id error surface can only carry a registry literal', () => {
    // What the deleted test was reaching for, asserted where it is actually
    // decidable. This is the tripwire for the two widenings already discussed in
    // the module docs — pulling date normalization into `normalizeModelId`, or
    // adopting spawn's "unknown ⇒ deep": either makes this branch live on
    // arbitrary strings, and then the sanitizer needs coverage BEFORE it lands.
    const dated = getModelId('deep', PROVIDER) + '-20260601';
    expect(() => headlessStepModelOverride(dated, 'fast', 'autonomous'))
      .toThrow(/cannot run autonomously without explicit consent/);
    let msg = '';
    try { headlessStepModelOverride(dated, 'fast', 'autonomous'); } catch (err) { msg = (err as Error).message; }
    // A fallback message (e.g. from a missing refusal) fails BOTH of these.
    expect(msg).toContain(dated);
    expect(msg).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it('passes an unknown-band raw id when autonomous (self-host local pins)', () => {
    expect(headlessStepModelOverride('my-local-gateway-model', 'fast', 'autonomous')).toBe('my-local-gateway-model');
  });

  it('refuses a DATE-SUFFIXED deep model id — "unknown" must not cover a dated snapshot', () => {
    // normalizeModelId strips only the Vertex `@YYYYMMDD` form, so an
    // Anthropic-style dash-dated snapshot of a registered deep model missed the
    // registry and took the unknown-band branch, which PASSES headless. An
    // operator pinning a dated Opus in a step would have run it autonomously at
    // the deep rate with no consent (on any instance without a max_tier).
    const dated = getModelId('deep', PROVIDER) + '-20260601';
    expect(() => headlessStepModelOverride(dated, 'fast', 'autonomous'))
      .toThrow(/cannot run autonomously without explicit consent/);
  });

  it('still passes a dated id whose BASE is not a registered deep model', () => {
    // The counter-direction, and the reason this is a suffix-aware lookup rather
    // than the spawn side's "unknown ⇒ deep": a local pin that merely happens to
    // carry a date must keep working, or every self-host autonomous workflow on
    // a versioned local model breaks. Both of these DO carry an 8-digit tail, so
    // the suffix branch actually engages and the base lookup is what decides.
    expect(headlessStepModelOverride('my-local-gateway-model-20260601', 'fast', 'autonomous'))
      .toBe('my-local-gateway-model-20260601');
    expect(headlessStepModelOverride('llama-3-70b-20260601', 'fast', 'autonomous'))
      .toBe('llama-3-70b-20260601');
  });

  it('the suffix branch is 8 DIGITS, not a validated date — stated, not implied', () => {
    // Honest scope. The strip is `-\d{8}$`; it cannot tell a date from any eight
    // digits, so a deep base wearing a nonsense tail is refused too. That is the
    // fail-closed direction and therefore fine, but it must not be described as
    // "date-aware" anywhere — an earlier version of this test claimed exactly
    // that while feeding it an input with no 8-digit tail at all, so nothing
    // checked either half of the claim.
    const deep = getModelId('deep', PROVIDER);
    expect(() => headlessStepModelOverride(`${deep}-99999999`, 'fast', 'autonomous')).toThrow();
    expect(() => headlessStepModelOverride(`${deep}-00000000`, 'fast', 'autonomous')).toThrow();
    // Seven or nine digits do not engage the branch — the id stays unknown.
    expect(headlessStepModelOverride(`${deep}-1234567`, 'fast', 'autonomous')).toBe(`${deep}-1234567`);
    expect(headlessStepModelOverride(`${deep}-123456789`, 'fast', 'autonomous')).toBe(`${deep}-123456789`);
  });

  it('returns non-deep requests untouched when autonomous', () => {
    expect(headlessStepModelOverride('fast', 'fast', 'autonomous')).toBe('fast');
    expect(headlessStepModelOverride(undefined, 'balanced', 'autonomous')).toBeUndefined();
  });

  it('returns requests untouched when interactive (autonomy not autonomous)', () => {
    expect(headlessStepModelOverride('deep', 'fast', 'guided')).toBe('deep');
    expect(headlessStepModelOverride('deep', 'fast', undefined)).toBe('deep');
    expect(headlessStepModelOverride(undefined, 'deep', 'guided')).toBeUndefined();
  });
});

describe('composition with resolveRunModel (the ceiling re-application)', () => {
  it('never lands a clamped step ABOVE the tenant max_tier (fast ceiling)', () => {
    // requested deep + ceiling fast: the old substituting clamp produced
    // balanced — ABOVE the ceiling. The request rewrite must not.
    const resolved = resolveRunModel({
      requested: headlessStepModelOverride('deep', 'fast', 'autonomous'),
      defaultTier: 'fast',
      accountTier: undefined,
      maxTier: 'fast',
      blockedModelIds: undefined,
      provider: PROVIDER,
    });
    expect(resolved.tier).toBe('fast');
  });

  it('resolves to balanced when the ceiling allows it', () => {
    const resolved = resolveRunModel({
      requested: headlessStepModelOverride('deep', 'fast', 'autonomous'),
      defaultTier: 'fast',
      accountTier: undefined,
      maxTier: 'deep',
      blockedModelIds: undefined,
      provider: PROVIDER,
    });
    expect(resolved.tier).toBe('balanced');
    expect(resolved.modelId).toBe(getModelId('balanced', PROVIDER));
  });

  it('re-applies the model blocklist to the clamped request', () => {
    // Block the balanced-band model: the clamped request must fall back to
    // fast (resolveRunModel's rule), never run the blocked id.
    const balancedId = getModelId('balanced', PROVIDER);
    const resolved = resolveRunModel({
      requested: headlessStepModelOverride('deep', 'fast', 'autonomous'),
      defaultTier: 'fast',
      accountTier: undefined,
      maxTier: 'deep',
      blockedModelIds: [balancedId],
      provider: PROVIDER,
    });
    expect(resolved.modelId).not.toBe(balancedId);
  });
});

describe('spawnInline wiring (run_workflow inline steps)', () => {
  it('runs a model:deep step on balanced when the session is autonomous', async () => {
    const step = { id: 's1', task: 'do', model: 'deep' } as unknown as ManifestStep;
    await spawnInline(step, {}, mockConfig, mockParentTools, undefined, 'autonomous');
    expect(agentModelOfCall(0)).toBe(getModelId('balanced', PROVIDER));
  });

  it('honors a fast max_tier ceiling even when the step asked for deep (no escalation)', async () => {
    const cfg = { api_key: 'test-key', max_tier: 'fast' } as unknown as LynoxUserConfig;
    const step = { id: 's1', task: 'do', model: 'deep' } as unknown as ManifestStep;
    await spawnInline(step, {}, cfg, mockParentTools, undefined, 'autonomous');
    expect(agentModelOfCall(0)).toBe(getModelId('fast', PROVIDER));
  });

  it('keeps a model:deep step on deep for an interactive session', async () => {
    const step = { id: 's1', task: 'do', model: 'deep' } as unknown as ManifestStep;
    await spawnInline(step, {}, mockConfig, mockParentTools);
    expect(agentModelOfCall(0)).toBe(getModelId('deep', PROVIDER));
  });

  it('refuses a deep-band raw id step when autonomous', async () => {
    const pinned = getModelId('deep', PROVIDER);
    const step = { id: 's1', task: 'do', model: pinned } as unknown as ManifestStep;
    await expect(spawnInline(step, {}, mockConfig, mockParentTools, undefined, 'autonomous'))
      .rejects.toThrow(/cannot run autonomously without explicit consent/);
    expect(vi.mocked(Agent).mock.calls).toHaveLength(0);
  });
});

describe('resolveModelForCost wiring (budget precheck + step-row stamp)', () => {
  it('prices the CLAMPED model when autonomous — not the refused deep announcement', async () => {
    const { resolveModelForCost } = await import('./runner.js');
    const step = { id: 's1', task: 'do', model: 'deep' } as unknown as ManifestStep;
    expect(resolveModelForCost(step, 'fast', mockConfig, 'autonomous')).toBe(getModelId('balanced', PROVIDER));
  });

  it('prices the deep model for an interactive session', async () => {
    const { resolveModelForCost } = await import('./runner.js');
    const step = { id: 's1', task: 'do', model: 'deep' } as unknown as ManifestStep;
    expect(resolveModelForCost(step, 'fast', mockConfig, undefined)).toBe(getModelId('deep', PROVIDER));
  });
});

describe('spawnViaAgent wiring (saved/agent steps)', () => {
  const agentDefDeep = { name: 'worker', defaultTier: 'deep', tools: [] } as unknown as AgentDef;

  it('clamps a deep agent default to balanced when the session is autonomous', async () => {
    const step = { id: 's1', agent: 'worker', task: 'do' } as unknown as ManifestStep;
    await spawnViaAgent(step, agentDefDeep, {}, mockConfig, undefined, 'run-1', undefined, 'autonomous');
    expect(agentModelOfCall(0)).toBe(getModelId('balanced', PROVIDER));
  });

  it('clamps a deep agent default through an empty model string (the empty-string bypass)', async () => {
    const step = { id: 's1', agent: 'worker', task: 'do', model: '' } as unknown as ManifestStep;
    await spawnViaAgent(step, agentDefDeep, {}, mockConfig, undefined, 'run-1', undefined, 'autonomous');
    expect(agentModelOfCall(0)).toBe(getModelId('balanced', PROVIDER));
  });

  it('keeps a deep agent default on deep for an interactive session', async () => {
    const step = { id: 's1', agent: 'worker', task: 'do' } as unknown as ManifestStep;
    await spawnViaAgent(step, agentDefDeep, {}, mockConfig, undefined, 'run-1');
    expect(agentModelOfCall(0)).toBe(getModelId('deep', PROVIDER));
  });
});
