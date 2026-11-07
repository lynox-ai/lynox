import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OWNER_PRINCIPAL } from '../../core/request-principal.js';
import { apiSetupTool, notConnectedNote } from './api-setup.js';
import { ApiStore, accessTokenKey, refreshTokenKey, type ApiProfile } from '../../core/api-store.js';
import { bindingsAsMigrated } from '../../../tests/helpers/vault-bindings.js';

/**
 * `view` on a built-in provider's profile that holds no token says it is not connected and how
 * it gets connected. Without that line a model asked to connect it wrote the connect call into
 * its reply as a link and never made it (1312).
 */

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

beforeEach(() => { mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-not-connected-')); });
afterEach(() => { rmSync(mockLynoxDir, { recursive: true, force: true }); });

const LINE = 'Connection: not connected yet. When the user wants it connected, call api_setup with action "connect" and id "books"; that call returns the sign-in link for the user, or says why there is none. A link or a tool call written into your reply connects nothing.';

function bexio(over: Partial<NonNullable<NonNullable<ApiProfile['auth']>['oauth']>> = {}): ApiProfile {
  return {
    id: 'books',
    name: 'bexio',
    base_url: 'https://api.bexio.com',
    description: 'bexio API',
    auth: { type: 'oauth2', oauth: { preset_id: 'bexio', ...over } },
  };
}

/** A vault that holds exactly `held`. */
function vault(held: Record<string, string> = {}): { resolve: (name: string) => string | null; extractSecretNames: () => string[]; resolveSecretRefs: (input: unknown) => unknown } {
  return {
    resolve: (name: string) => held[name] ?? null,
    extractSecretNames: () => [],
    resolveSecretRefs: (input: unknown) => input,
  };
}

function agentWith(store: ApiStore, secretStore: ReturnType<typeof vault> | undefined): never {
  return {
    principal: OWNER_PRINCIPAL,
    sessionCounters: { httpRequests: 0 },
    secretStore,
    toolContext: { vaultNameBindings: bindingsAsMigrated(store), apiStore: store, dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {}, tools: [], streamHandler: null, networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity, isolationEnvOverride: undefined, isolationMinimalEnv: false },
  } as never;
}

async function view(profile: ApiProfile, secretStore: ReturnType<typeof vault> | undefined): Promise<string> {
  const store = new ApiStore();
  store.register(profile);
  return await apiSetupTool.handler({ action: 'view', id: profile.id }, agentWith(store, secretStore)) as string;
}

describe('view says a built-in provider\'s profile is not connected yet', () => {
  it('adds the line, after the stored profile data, when neither token is held', async () => {
    const reply = await view(bexio(), vault());
    expect(reply.endsWith(`</api_profile_stored>\n\n${LINE}`)).toBe(true);
  });

  it('leaves it out when the access token is held', async () => {
    expect(await view(bexio(), vault({ [accessTokenKey('books')]: 'a' }))).not.toContain('Connection:');
  });

  it('leaves it out when only the refresh token is held: the profile may be connected', async () => {
    expect(await view(bexio(), vault({ [refreshTokenKey('books')]: 'r' }))).not.toContain('Connection:');
  });

  it('reads the refresh slot the profile names, not only the derived one', async () => {
    const named = bexio({ refresh_token_key: 'BOOKS_RT' });
    expect(await view(named, vault({ BOOKS_RT: 'r' }))).not.toContain('Connection:');
    // The derived name alone does not count for a profile that reads another one.
    expect(await view(named, vault({ [refreshTokenKey('books')]: 'r' }))).toContain(LINE);
  });

  it('leaves it out for a profile without a built-in provider', async () => {
    const own: ApiProfile = { ...bexio(), id: 'books', base_url: 'https://api.example.com', auth: { type: 'oauth2', oauth: { token_url: 'https://api.example.com/token' } } };
    expect(await view(own, vault())).not.toContain('Connection:');
  });

  it('leaves it out for a static-credential profile that still carries a preset_id', () => {
    const bearer = { ...bexio(), base_url: 'https://api.example.com', auth: { type: 'bearer', oauth: { preset_id: 'bexio' } } } as ApiProfile;
    expect(notConnectedNote({ secretStore: vault() } as never, bearer)).toBe('');
  });

  it('leaves it out when there is no vault to ask', async () => {
    expect(await view(bexio(), undefined)).not.toContain('Connection:');
  });
});
