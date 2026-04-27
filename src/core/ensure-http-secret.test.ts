import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Stand-alone test for ensureHttpSecret — keeps mocks minimal so the
// function's filesystem behaviour is exercised against a real tmpdir.
//
// Mocks the rest of engine-init's heavy deps so the import succeeds.

vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn() }));
vi.mock('./run-history.js', () => ({ RunHistory: vi.fn() }));
vi.mock('./memory.js', () => ({ Memory: vi.fn() }));
vi.mock('./secret-vault.js', () => ({ SecretVault: vi.fn() }));
vi.mock('./secret-store.js', () => ({ SecretStore: vi.fn() }));
vi.mock('./session-budget.js', () => ({ configurePersistentBudget: vi.fn() }));
vi.mock('../tools/builtin/http.js', () => ({
  configureHttpRateLimits: vi.fn(),
  configureEnforceHttps: vi.fn(),
}));
vi.mock('../integrations/mail/tools/rate-limit.js', () => ({
  configureMailRateLimits: vi.fn(),
}));
vi.mock('./scope-resolver.js', () => ({
  resolveActiveScopes: vi.fn().mockReturnValue([]),
  scopeWeight: vi.fn().mockReturnValue(0),
}));
vi.mock('./observability.js', () => ({
  channels: {
    secretAccess: { publish: vi.fn() },
    contentTruncation: { hasSubscribers: false, publish: vi.fn() },
    toolEnd: { subscribe: vi.fn(), publish: vi.fn() },
    spawnEnd: { subscribe: vi.fn() },
    dataStoreInsert: { subscribe: vi.fn() },
    memoryStore: { subscribe: vi.fn() },
  },
}));
vi.mock('./workspace.js', () => ({
  isWorkspaceActive: vi.fn().mockReturnValue(false),
  getWorkspaceDir: vi.fn().mockReturnValue('/workspace'),
}));

const mockGetLynoxDir = vi.fn();
vi.mock('./config.js', () => ({
  setVaultApiKeyExists: vi.fn(),
  getLynoxDir: () => mockGetLynoxDir(),
}));

vi.mock('./project.js', () => ({
  generateBriefing: vi.fn(),
  buildFileManifest: vi.fn(),
  diffManifest: vi.fn(),
  formatManifestDiff: vi.fn(),
  loadManifest: vi.fn(),
  detectProjectRoot: vi.fn(),
}));

import { ensureHttpSecret } from './engine-init.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'lynox-http-secret-test-'));
  mockGetLynoxDir.mockReturnValue(tmpDir);
  delete process.env['LYNOX_HTTP_SECRET'];
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env['LYNOX_HTTP_SECRET'];
});

describe('ensureHttpSecret', () => {
  it('is a no-op when LYNOX_HTTP_SECRET is already set', () => {
    process.env['LYNOX_HTTP_SECRET'] = 'pre-existing-secret';
    ensureHttpSecret();
    expect(process.env['LYNOX_HTTP_SECRET']).toBe('pre-existing-secret');
    expect(existsSync(join(tmpDir, 'http-secret'))).toBe(false);
  });

  it('generates and persists a 64-hex-char secret on first run', () => {
    ensureHttpSecret();
    const value = process.env['LYNOX_HTTP_SECRET'];
    expect(value).toBeDefined();
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    const persisted = readFileSync(join(tmpDir, 'http-secret'), 'utf-8').trim();
    expect(persisted).toBe(value);
  });

  it('persists the secret with mode 0600', () => {
    ensureHttpSecret();
    const mode = statSync(join(tmpDir, 'http-secret')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('reuses the persisted secret on subsequent runs', () => {
    ensureHttpSecret();
    const first = process.env['LYNOX_HTTP_SECRET']!;
    delete process.env['LYNOX_HTTP_SECRET'];
    ensureHttpSecret();
    expect(process.env['LYNOX_HTTP_SECRET']).toBe(first);
  });

  it('regenerates when the persisted file is empty / whitespace only', () => {
    writeFileSync(join(tmpDir, 'http-secret'), '   \n', { mode: 0o600 });
    ensureHttpSecret();
    expect(process.env['LYNOX_HTTP_SECRET']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('trims surrounding whitespace from a persisted value', () => {
    writeFileSync(join(tmpDir, 'http-secret'), '  pre-stored-secret-value  \n', { mode: 0o600 });
    ensureHttpSecret();
    expect(process.env['LYNOX_HTTP_SECRET']).toBe('pre-stored-secret-value');
  });
});
