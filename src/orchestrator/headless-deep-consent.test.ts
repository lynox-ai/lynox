import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolEntry, LynoxUserConfig } from '../types/index.js';
import { getModelId } from '../types/index.js';

// The headless deep-consent parity for pipeline steps — the spawn-side D2
// clamp applied at the two step-resolution sites (spawnInline for run_workflow
// inline steps, spawnViaAgent for saved/agent steps). A consent boundary that a
// sibling fan-out tool bypasses is not a boundary, so these tests pin BOTH the
// pure predicate and the wiring at each site: autonomous deep is clamped to
// balanced, a deep-band raw id is refused, interactive deep is untouched.

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
import { enforceHeadlessStepDeepConsent, spawnInline, spawnViaAgent } from './runtime-adapter.js';
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

describe('enforceHeadlessStepDeepConsent (pure)', () => {
  const deepResolved = { tier: 'deep' as const, modelId: getModelId('deep', PROVIDER) };

  it('clamps a requested deep tier to balanced when autonomous', () => {
    const out = enforceHeadlessStepDeepConsent(deepResolved, 'deep', 'fast', 'autonomous', PROVIDER);
    expect(out.tier).toBe('balanced');
    expect(out.modelId).toBe(getModelId('balanced', PROVIDER));
  });

  it('clamps the legacy deep alias (opus) to balanced when autonomous', () => {
    const out = enforceHeadlessStepDeepConsent(deepResolved, 'opus', 'fast', 'autonomous', PROVIDER);
    expect(out.tier).toBe('balanced');
  });

  it('clamps a deep step default reaching an undeclared step when autonomous', () => {
    const out = enforceHeadlessStepDeepConsent(deepResolved, undefined, 'deep', 'autonomous', PROVIDER);
    expect(out.tier).toBe('balanced');
  });

  it('refuses a deep-band raw model id when autonomous (cannot be substituted)', () => {
    const pinned = getModelId('deep', PROVIDER); // a registered deep-band id
    expect(() => enforceHeadlessStepDeepConsent({ tier: 'fast', modelId: pinned }, pinned, 'fast', 'autonomous', PROVIDER))
      .toThrow(/cannot run autonomously without explicit consent/);
  });

  it('passes an unknown-band raw id when autonomous (self-host local pins)', () => {
    const pinned = 'my-local-gateway-model';
    const out = enforceHeadlessStepDeepConsent({ tier: 'fast', modelId: pinned }, pinned, 'fast', 'autonomous', PROVIDER);
    expect(out.modelId).toBe(pinned);
  });

  it('returns the resolution untouched for non-deep requests when autonomous', () => {
    const fast = { tier: 'fast' as const, modelId: getModelId('fast', PROVIDER) };
    expect(enforceHeadlessStepDeepConsent(fast, 'fast', 'fast', 'autonomous', PROVIDER)).toEqual(fast);
  });

  it('returns the resolution untouched when interactive (autonomy not autonomous)', () => {
    expect(enforceHeadlessStepDeepConsent(deepResolved, 'deep', 'fast', 'guided', PROVIDER)).toEqual(deepResolved);
    expect(enforceHeadlessStepDeepConsent(deepResolved, 'deep', 'fast', undefined, PROVIDER)).toEqual(deepResolved);
  });
});

describe('spawnInline wiring (run_workflow inline steps)', () => {
  it('runs a model:deep step on balanced when the session is autonomous', async () => {
    const step = { id: 's1', task: 'do' } as unknown as ManifestStep & { model?: string };
    (step as { model?: string }).model = 'deep';
    await spawnInline(step, {}, mockConfig, mockParentTools, undefined, 'autonomous');
    expect(agentModelOfCall(0)).toBe(getModelId('balanced', PROVIDER));
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

describe('spawnViaAgent wiring (saved/agent steps)', () => {
  const agentDefDeep = { name: 'worker', defaultTier: 'deep', tools: [] } as unknown as AgentDef;

  it('clamps a deep agent default to balanced when the session is autonomous', async () => {
    const step = { id: 's1', agent: 'worker', task: 'do' } as unknown as ManifestStep;
    await spawnViaAgent(step, agentDefDeep, {}, mockConfig, undefined, 'run-1', undefined, 'autonomous');
    expect(agentModelOfCall(0)).toBe(getModelId('balanced', PROVIDER));
  });

  it('keeps a deep agent default on deep for an interactive session', async () => {
    const step = { id: 's1', agent: 'worker', task: 'do' } as unknown as ManifestStep;
    await spawnViaAgent(step, agentDefDeep, {}, mockConfig, undefined, 'run-1');
    expect(agentModelOfCall(0)).toBe(getModelId('deep', PROVIDER));
  });
});
