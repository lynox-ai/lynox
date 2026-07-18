import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all heavy dependencies that generateInitBriefing needs
const { memoryCtorSpy } = vi.hoisted(() => ({ memoryCtorSpy: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));
vi.mock('./run-history.js', () => ({ RunHistory: vi.fn() }));
vi.mock('./memory.js', () => ({
  Memory: class {
    constructor(...args: unknown[]) { memoryCtorSpy(...args); }
    setActiveScopes(): void { /* stub */ }
    setAutoScope(): void { /* stub */ }
    setExtractionLimit(): void { /* stub */ }
    async loadAll(): Promise<void> { /* stub */ }
  },
}));
vi.mock('./features.js', () => ({ isFeatureEnabled: () => false }));
vi.mock('./secret-vault.js', () => ({ SecretVault: vi.fn() }));
vi.mock('./secret-store.js', () => ({ SecretStore: vi.fn() }));
vi.mock('./config.js', () => ({
  setVaultApiKeyExists: vi.fn(),
  getLynoxDir: vi.fn().mockReturnValue('/tmp/.lynox'),
}));
vi.mock('./session-budget.js', () => ({ configurePersistentBudget: vi.fn() }));
vi.mock('../tools/builtin/http.js', () => ({
  configureHttpRateLimits: vi.fn(),
  configureEnforceHttps: vi.fn(),
}));
vi.mock('./scope-resolver.js', () => ({
  resolveActiveScopes: vi.fn().mockReturnValue([]),
}));
vi.mock('./observability.js', () => ({
  channels: {
    secretAccess: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: false, publish: vi.fn() },
  },
}));
vi.mock('./workspace.js', () => ({
  isWorkspaceActive: vi.fn().mockReturnValue(false),
  getWorkspaceDir: vi.fn().mockReturnValue('/workspace'),
}));

// Mock project.ts to control briefing content
const mockGenerateBriefing = vi.fn().mockReturnValue('');
const mockBuildFileManifest = vi.fn().mockReturnValue(new Map());
const mockDiffManifest = vi.fn().mockReturnValue({ added: [], removed: [], modified: [] });
const mockFormatManifestDiff = vi.fn().mockReturnValue('');
const mockLoadManifest = vi.fn().mockReturnValue(null);

vi.mock('./project.js', () => ({
  generateBriefing: (...args: unknown[]) => mockGenerateBriefing(...args),
  buildFileManifest: (...args: unknown[]) => mockBuildFileManifest(...args),
  diffManifest: (...args: unknown[]) => mockDiffManifest(...args),
  formatManifestDiff: (...args: unknown[]) => mockFormatManifestDiff(...args),
  loadManifest: (...args: unknown[]) => mockLoadManifest(...args),
  detectProjectRoot: vi.fn(),
}));

import { generateInitBriefing, initMemoryInstance, configureBudgetAndRateLimits, initScopes } from './engine-init.js';
import { resolveActiveScopes } from './scope-resolver.js';
import { createToolContext } from './tool-context.js';
import type { LynoxContext, LynoxConfig, LynoxUserConfig } from '../types/index.js';
import type { SecretStore } from './secret-store.js';

const cliContext: LynoxContext = {
  id: 'test-ctx',
  source: 'cli',
  workspaceDir: '/tmp/test',
  localDir: '/tmp/test',
};

// Minimal mock RunHistory — just needs to be truthy for the `if (runHistory)` checks
const mockRunHistory = {} as import('./run-history.js').RunHistory;

describe('generateInitBriefing', () => {
  it('caps briefing at 8000 chars', async () => {
    // Simulate a huge file manifest diff
    const hugeDiff = 'x'.repeat(20_000);
    mockGenerateBriefing.mockReturnValue('<session_briefing>short run history</session_briefing>');
    mockLoadManifest.mockReturnValue(new Map([['a.ts', 1]]));
    mockFormatManifestDiff.mockReturnValue(hugeDiff);

    const result = await generateInitBriefing(cliContext, mockRunHistory, []);

    expect(result.briefing).toBeDefined();
    expect(result.briefing!.length).toBeLessThanOrEqual(8_000 + 30); // +30 for truncation suffix
  });

  it('preserves run history when trimming manifest diff', async () => {
    const hugeDiff = 'y'.repeat(20_000);
    const runHistory = '<session_briefing>important run context</session_briefing>';
    mockGenerateBriefing.mockReturnValue(runHistory);
    mockLoadManifest.mockReturnValue(new Map([['a.ts', 1]]));
    mockFormatManifestDiff.mockReturnValue(hugeDiff);

    const result = await generateInitBriefing(cliContext, mockRunHistory, []);

    expect(result.briefing).toBeDefined();
    // Run history should be preserved intact
    expect(result.briefing).toContain('important run context');
    // Manifest diff should be truncated
    expect(result.briefing).toContain('file changes truncated');
  });

  it('does not truncate small briefings', async () => {
    const shortBriefing = '<session_briefing>short</session_briefing>';
    mockGenerateBriefing.mockReturnValue(shortBriefing);
    mockLoadManifest.mockReturnValue(null);
    mockFormatManifestDiff.mockReturnValue('');

    const result = await generateInitBriefing(cliContext, mockRunHistory, []);

    expect(result.briefing).toBe(shortBriefing);
    expect(result.briefing).not.toContain('truncated');
  });

  it('returns undefined for non-cli context', async () => {
    const result = await generateInitBriefing(
      { ...cliContext, source: 'pwa' },
      null,
      [],
    );
    expect(result.briefing).toBeUndefined();
  });
});

describe('initScopes — no <memory_scopes> leak (2026-07-18)', () => {
  it('resolves scopes for retrieval but never surfaces a <memory_scopes> block', () => {
    // The `context:http-api` transport scope label used to be echoed to the model
    // as `<memory_scopes>`, which it reported as "Fokus: http-api (Projekt/Kontext)"
    // and confabulated a project around. Scopes must still resolve — just not leak.
    //
    // Load-bearing setup: a NON-EMPTY scope so the OLD `if (scopes.length > 0)` leak
    // branch WOULD have fired — otherwise (with the default []-mock) the assertion
    // below passes on unpatched code too, which makes it worthless.
    vi.mocked(resolveActiveScopes).mockReturnValueOnce([
      { type: 'context', id: 'http-api' },
      { type: 'user', id: 'u1' },
    ] as unknown as ReturnType<typeof resolveActiveScopes>);

    const result = initScopes(
      { user_id: 'u1' } as unknown as LynoxUserConfig,
      cliContext,
      mockRunHistory,
      null,
    );
    expect(result.scopes.length).toBeGreaterThan(0); // the leak branch's precondition held
    // The scope id 'http-api' is legitimately RETURNED (it drives retrieval) — what
    // must be gone is the `<memory_scopes>` briefing string built FROM it.
    expect(JSON.stringify(result)).not.toContain('memory_scopes');
    // The `briefingPart` field is gone from ScopeResult entirely.
    expect('briefingPart' in result).toBe(false);
  });
});

describe('initMemoryInstance — provider-resolved key', () => {
  beforeEach(() => memoryCtorSpy.mockReset());

  // Regression guard: the Memory auto-extract client must authenticate with the
  // provider's own key slot. Passing userConfig.api_key (the ANTHROPIC slot)
  // unconditionally — the pre-fix behaviour — sent an Anthropic / empty key to
  // api.mistral.ai on a Mistral tenant → 401 → silent dead memory extraction.
  it('passes the MISTRAL slot key (not the Anthropic config key) on the openai provider', async () => {
    const prev = process.env['MISTRAL_API_KEY'];
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-RIGHT';
    try {
      const config = { memory: true } as unknown as LynoxConfig;
      const userConfig = {
        provider: 'openai',
        api_key: 'sk-ant-WRONG-anthropic-slot',
        api_base_url: 'https://api.mistral.ai/v1',
        openai_model_id: 'mistral-large-2512',
      } as unknown as LynoxUserConfig;

      await initMemoryInstance(config, userConfig, [], 'ctx1', null);

      expect(memoryCtorSpy).toHaveBeenCalledOnce();
      const args = memoryCtorSpy.mock.calls[0]!;
      expect(args[1]).toBe('sk-mistral-RIGHT');         // arg 2 = apiKey
      expect(args[1]).not.toBe('sk-ant-WRONG-anthropic-slot');
      expect(args[6]).toBe('openai');                    // arg 7 = provider
    } finally {
      if (prev === undefined) delete process.env['MISTRAL_API_KEY'];
      else process.env['MISTRAL_API_KEY'] = prev;
    }
  });

  it('honours the legacy Anthropic config.api_key fallback on the anthropic provider', async () => {
    const prevA = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const config = { memory: true } as unknown as LynoxConfig;
      const userConfig = {
        provider: 'anthropic',
        api_key: 'sk-ant-legacy-config',
      } as unknown as LynoxUserConfig;
      const secretStore = { resolve: () => null } as unknown as SecretStore;

      await initMemoryInstance(config, userConfig, [], undefined, secretStore);

      const args = memoryCtorSpy.mock.calls.at(-1)!;
      expect(args[1]).toBe('sk-ant-legacy-config');
    } finally {
      if (prevA !== undefined) process.env['ANTHROPIC_API_KEY'] = prevA;
    }
  });
});

describe('configureBudgetAndRateLimits — http-tool security wiring', () => {
  // configurePersistentBudget is mocked above; applyEnforceHttps + applyNetworkPolicy
  // (from tool-context.js) run for real and mutate the ToolContext.
  const base: LynoxUserConfig = {};

  it('applies network_policy + allowed hosts from config onto the ToolContext', () => {
    const ctx = createToolContext(base);
    configureBudgetAndRateLimits(
      mockRunHistory,
      { ...base, network_policy: 'allow-list', network_allowed_hosts: ['api.example.com', '*.cdn.example.com'] },
      ctx,
    );
    expect(ctx.networkPolicy).toBe('allow-list');
    expect(ctx.allowedHosts).toEqual(new Set(['api.example.com']));
    expect(ctx.allowedWildcards).toEqual(['cdn.example.com']);
  });

  it('defaults to allow-all (no egress restriction) when unset — zero behaviour change', () => {
    const ctx = createToolContext(base);
    configureBudgetAndRateLimits(mockRunHistory, base, ctx);
    expect(ctx.networkPolicy).toBe('allow-all');
    expect(ctx.allowedHosts).toBeUndefined();
  });

  it('wires enforce_https from config (pre-existing gap, now covered)', () => {
    const ctx = createToolContext(base);
    configureBudgetAndRateLimits(mockRunHistory, { ...base, enforce_https: true }, ctx);
    expect(ctx.enforceHttps).toBe(true);
  });

  it('wires the guarded policy + keeps the operator floor onto the ToolContext', () => {
    const ctx = createToolContext(base);
    configureBudgetAndRateLimits(
      mockRunHistory,
      { ...base, network_policy: 'guarded', network_allowed_hosts: ['ops.example.com'] },
      ctx,
    );
    expect(ctx.networkPolicy).toBe('guarded');
    // The operator floor is still split into allowedHosts under guarded.
    expect(ctx.allowedHosts).toEqual(new Set(['ops.example.com']));
  });

  it('boot-logs the active posture with the guarded-capable marker (rollout-order gate greps it)', () => {
    const ctx = createToolContext(base);
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let lines: string[] = [];
    try {
      configureBudgetAndRateLimits(mockRunHistory, { ...base, network_policy: 'guarded' }, ctx);
      // Read the captured calls BEFORE mockRestore() (which resets mock.calls).
      lines = writeSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      writeSpy.mockRestore();
    }
    expect(lines.some((l) => l.includes('egress policy: guarded') && l.includes('guarded-capable build'))).toBe(true);
  });
});
