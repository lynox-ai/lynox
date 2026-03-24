import { describe, it, expect, vi } from 'vitest';

// Mock all heavy dependencies that generateInitBriefing needs
vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));
vi.mock('./run-history.js', () => ({ RunHistory: vi.fn() }));
vi.mock('./memory.js', () => ({ Memory: vi.fn() }));
vi.mock('./secret-vault.js', () => ({ SecretVault: vi.fn() }));
vi.mock('./secret-store.js', () => ({ SecretStore: vi.fn() }));
vi.mock('./config.js', () => ({
  setVaultApiKeyExists: vi.fn(),
  getNodynDir: vi.fn().mockReturnValue('/tmp/.nodyn'),
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

import { generateInitBriefing } from './orchestrator-init.js';
import type { NodynContext } from '../types/index.js';

const cliContext: NodynContext = {
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
      { ...cliContext, source: 'telegram' },
      null,
      [],
    );
    expect(result.briefing).toBeUndefined();
  });
});
