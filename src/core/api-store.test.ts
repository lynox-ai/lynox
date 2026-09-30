import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmdirSync, writeFileSync, rmSync, readFileSync, readdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ApiStore, vaultSlotBase, accessTokenKey, refreshTokenKey } from './api-store.js';
import type { ApiProfile } from './api-store.js';
import { SUGGESTED_API_CATALOG } from './suggested-apis.js';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lynox-api-store-test-'));
}

const SAMPLE_PROFILE: ApiProfile = {
  id: 'test-api',
  name: 'Test API',
  base_url: 'https://api.test.com/v1',
  description: 'A test API for unit testing.',
  auth: { type: 'bearer' },
  rate_limit: { requests_per_second: 5, requests_per_minute: 100 },
  endpoints: [
    { method: 'POST', path: '/search', description: 'Search for items' },
    { method: 'GET', path: '/items/{id}', description: 'Get item by ID' },
  ],
  guidelines: ['Always use JSON body', 'Include pagination params'],
  avoid: ['Do not use GET for mutations', 'Do not exceed 50 items per request'],
  notes: ['Responses are paginated', 'Rate limit resets every minute'],
};

describe('ApiStore', () => {
  let store: ApiStore;

  beforeEach(() => {
    store = new ApiStore();
  });

  describe('register', () => {
    it('registers a profile and retrieves by id', () => {
      store.register(SAMPLE_PROFILE);
      expect(store.size).toBe(1);
      expect(store.get('test-api')).toEqual(SAMPLE_PROFILE);
    });

    it('retrieves by hostname', () => {
      store.register(SAMPLE_PROFILE);
      const found = store.getByHostname('api.test.com');
      expect(found).toEqual(SAMPLE_PROFILE);
    });

    it('returns undefined for unknown id', () => {
      expect(store.get('nope')).toBeUndefined();
    });

    it('returns undefined for unknown hostname', () => {
      expect(store.getByHostname('unknown.com')).toBeUndefined();
    });
  });

  describe('unregister', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = createTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('removes from in-memory store and unlinks file', () => {
      writeFileSync(join(tmpDir, 'test-api.json'), JSON.stringify(SAMPLE_PROFILE));
      store.loadFromDirectory(tmpDir);
      expect(store.size).toBe(1);

      const removed = store.unregister('test-api', tmpDir);
      expect(removed).toBe(true);
      expect(store.size).toBe(0);
      expect(store.get('test-api')).toBeUndefined();
      expect(store.getByHostname('api.test.com')).toBeUndefined();
      expect(existsSync(join(tmpDir, 'test-api.json'))).toBe(false);
    });

    it('returns false for unknown id without touching disk', () => {
      writeFileSync(join(tmpDir, 'test-api.json'), JSON.stringify(SAMPLE_PROFILE));
      store.loadFromDirectory(tmpDir);

      const removed = store.unregister('does-not-exist', tmpDir);
      expect(removed).toBe(false);
      expect(store.size).toBe(1);
      expect(existsSync(join(tmpDir, 'test-api.json'))).toBe(true);
    });

    it('handles in-memory-only profiles without an apisDir', () => {
      store.register(SAMPLE_PROFILE);
      expect(store.unregister('test-api')).toBe(true);
      expect(store.size).toBe(0);
    });

    it('preserves a hostname mapping that was re-claimed by a newer profile', () => {
      const oldP = { ...SAMPLE_PROFILE, id: 'old' };
      const newP = { ...SAMPLE_PROFILE, id: 'new' };
      store.register(oldP);
      store.register(newP); // hostname now maps to 'new'

      const removed = store.unregister('old');
      expect(removed).toBe(true);
      // The newer profile's hostname mapping must survive — the older
      // profile we just removed never owned it after re-registration.
      expect(store.getByHostname('api.test.com')?.id).toBe('new');
    });

    it('clears the rate-limit bucket so a re-registration without limits is unthrottled', () => {
      const throttled: ApiProfile = { ...SAMPLE_PROFILE, rate_limit: { requests_per_second: 1 } };
      store.register(throttled);
      // Burn the only token so the next call would be blocked if the bucket survives.
      expect(store.checkRateLimit('api.test.com')).toBeNull();
      expect(store.checkRateLimit('api.test.com')).not.toBeNull();

      store.unregister('test-api');

      // Re-register without rate_limit; the throttled bucket must be gone.
      const unlimited: ApiProfile = { ...SAMPLE_PROFILE };
      store.register(unlimited);
      expect(store.checkRateLimit('api.test.com')).toBeNull();
      expect(store.checkRateLimit('api.test.com')).toBeNull();
    });

    it('returns false for a path-traversal-shaped id', () => {
      // `register` already rejects this id (verified separately), so the
      // unregister call sees an empty Map and returns false naturally.
      // Belt-and-suspenders: the regex guard inside unregister also blocks
      // the id from reaching `join(apisDir, …)` if a future regression in
      // register lets a bad id leak in.
      expect(store.unregister('../../escape', tmpDir)).toBe(false);
    });

    it('throws on real (non-ENOENT) unlink failure', async () => {
      const { ApiProfileUnlinkError } = await import('./api-store.js');
      writeFileSync(join(tmpDir, 'test-api.json'), JSON.stringify(SAMPLE_PROFILE));
      store.loadFromDirectory(tmpDir);
      // Point apisDir at a regular file so unlink(filePath) hits EISDIR/ENOTDIR-class errors.
      const notADir = join(tmpDir, 'not-a-dir');
      writeFileSync(notADir, 'plain file');
      expect(() => store.unregister('test-api', notADir)).toThrow(ApiProfileUnlinkError);
      // In-memory side still happened — that's the partial state the throw signals.
      expect(store.size).toBe(0);
    });
  });

  describe('register validation', () => {
    it('skips a profile with a malformed id', () => {
      const bad: ApiProfile = { ...SAMPLE_PROFILE, id: '../../escape' };
      store.register(bad);
      expect(store.size).toBe(0);
      expect(store.get('../../escape')).toBeUndefined();
    });
  });

  describe('loadFromDirectory', () => {
    let tmpDir: string;

    beforeEach(() => { tmpDir = createTmpDir(); });
    afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

    it('loads profiles from directory', () => {
      writeFileSync(join(tmpDir, 'test.json'), JSON.stringify(SAMPLE_PROFILE));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);
      expect(store.get('test-api')).toBeDefined();
    });

    it('skips non-json files', () => {
      writeFileSync(join(tmpDir, 'readme.txt'), 'not a profile');
      writeFileSync(join(tmpDir, 'test.json'), JSON.stringify(SAMPLE_PROFILE));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);
    });

    it('skips profiles with missing required fields', () => {
      writeFileSync(join(tmpDir, 'bad.json'), JSON.stringify({ id: 'bad' }));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(0);
    });

    it('skips invalid JSON', () => {
      writeFileSync(join(tmpDir, 'broken.json'), '{bad json');
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(0);
    });

    it('returns 0 for nonexistent directory', () => {
      const loaded = store.loadFromDirectory('/tmp/nonexistent-dir-abc123');
      expect(loaded).toBe(0);
    });

    it('loads multiple profiles', () => {
      const profile2: ApiProfile = { ...SAMPLE_PROFILE, id: 'second-api', name: 'Second', base_url: 'https://api2.test.com' };
      writeFileSync(join(tmpDir, 'first.json'), JSON.stringify(SAMPLE_PROFILE));
      writeFileSync(join(tmpDir, 'second.json'), JSON.stringify(profile2));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(2);
      expect(store.size).toBe(2);
    });
  });

  describe('rate limiting', () => {
    it('allows requests under limit', () => {
      store.register(SAMPLE_PROFILE); // 5/s, 100/min
      const result = store.checkRateLimit('api.test.com');
      expect(result).toBeNull();
    });

    it('blocks after exceeding per-second limit', () => {
      store.register({ ...SAMPLE_PROFILE, rate_limit: { requests_per_second: 2 } });
      expect(store.checkRateLimit('api.test.com')).toBeNull(); // 1
      expect(store.checkRateLimit('api.test.com')).toBeNull(); // 2
      const blocked = store.checkRateLimit('api.test.com');     // 3 → blocked
      expect(blocked).toBeTruthy();
      expect(blocked).toContain('rate limit');
      expect(blocked).toContain('api.test.com');
    });

    it('returns null for unknown hosts', () => {
      store.register(SAMPLE_PROFILE);
      expect(store.checkRateLimit('unknown.com')).toBeNull();
    });

    it('does not rate limit profiles without limits', () => {
      store.register({ ...SAMPLE_PROFILE, rate_limit: undefined });
      expect(store.checkRateLimit('api.test.com')).toBeNull();
      expect(store.checkRateLimit('api.test.com')).toBeNull();
      expect(store.checkRateLimit('api.test.com')).toBeNull();
    });
  });

  describe('formatForSystemPrompt', () => {
    it('returns empty string when no profiles', () => {
      expect(store.formatForSystemPrompt()).toBe('');
    });

    it('includes compact profile summary', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('Test API');
      expect(output).toContain('A test API for unit testing.');
      expect(output).toContain('api.test.com');
      expect(output).toContain('[bearer]');
      expect(output).toContain('2 endpoints');
    });

    it('does not include full details in summary', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).not.toContain('POST /search');
      expect(output).not.toContain('Always use JSON body');
      expect(output).not.toContain('Do not use GET for mutations');
    });

    it('wraps in api_profiles tags', () => {
      store.register(SAMPLE_PROFILE);
      const output = store.formatForSystemPrompt();
      expect(output).toContain('<api_profiles>');
      expect(output).toContain('</api_profiles>');
    });

    it('formatProfile returns full details', () => {
      store.register(SAMPLE_PROFILE);
      const profile = store.get('test-api')!;
      const output = store.formatProfile(profile);
      expect(output).toContain('POST /search');
      expect(output).toContain('GET /items/{id}');
      expect(output).toContain('Always use JSON body');
      expect(output).toContain('Include pagination params');
      expect(output).toContain('Do not use GET for mutations');
      expect(output).toContain('5/s');
      expect(output).toContain('100/min');
      expect(output).toContain('Bearer Token');
    });
  });

  describe('getAll', () => {
    it('returns all profiles', () => {
      store.register(SAMPLE_PROFILE);
      store.register({ ...SAMPLE_PROFILE, id: 'other', base_url: 'https://other.com' });
      expect(store.getAll()).toHaveLength(2);
    });
  });

  describe('getAcceptedEgressHosts (guarded network policy)', () => {
    // This set is the ONLY profile-derived widen path for the guarded egress
    // policy — a leak here (admitting a non-accepted host) defeats the gate, so
    // the accepted:true / array-shape guards are security-critical.
    it('unions custom_endpoint_ack.hosts across profiles (incl. token_url ≠ base_url)', () => {
      store.register({
        id: 'p1', name: 'P1', base_url: 'https://api.p1.net/v1', description: 'x',
        custom_endpoint_ack: { accepted: true, hosts: ['api.p1.net', 'token.p1.net'], accepted_at: 'now' },
      });
      store.register({
        id: 'p2', name: 'P2', base_url: 'https://api.p2.net/v1', description: 'x',
        custom_endpoint_ack: { accepted: true, hosts: ['api.p2.net'], accepted_at: 'now' },
      });
      expect(store.getAcceptedEgressHosts()).toEqual(new Set(['api.p1.net', 'token.p1.net', 'api.p2.net']));
    });

    it('EXCLUDES a profile whose ack is not accepted:true (no leak of a rejected host)', () => {
      store.register({
        id: 'rej', name: 'Rej', base_url: 'https://api.rej.net/v1', description: 'x',
        // accepted:false must never contribute — a relaxed `!= null` check would leak it.
        custom_endpoint_ack: { accepted: false as unknown as true, hosts: ['api.rej.net'], accepted_at: 'now' },
      });
      expect(store.getAcceptedEgressHosts().has('api.rej.net')).toBe(false);
    });

    it('EXCLUDES a profile with no ack at all', () => {
      store.register(SAMPLE_PROFILE); // no custom_endpoint_ack
      expect(store.getAcceptedEgressHosts().size).toBe(0);
    });

    it('does not throw when a corrupt profile has accepted:true but a non-array hosts', () => {
      // loadFromDirectory / engine.db parse profiles with no schema validation, so a
      // hand-edited/corrupt ack must not brick EVERY guarded request.
      store.register({
        id: 'bad', name: 'Bad', base_url: 'https://api.bad.net/v1', description: 'x',
        custom_endpoint_ack: { accepted: true, hosts: undefined as unknown as string[], accepted_at: 'now' },
      });
      store.register({
        id: 'good', name: 'Good', base_url: 'https://api.good.net/v1', description: 'x',
        custom_endpoint_ack: { accepted: true, hosts: ['api.good.net'], accepted_at: 'now' },
      });
      expect(() => store.getAcceptedEgressHosts()).not.toThrow();
      // The valid profile still contributes; the corrupt one is skipped, not fatal.
      expect(store.getAcceptedEgressHosts()).toEqual(new Set(['api.good.net']));
    });
  });

  describe('v2 schema migration', () => {
    let tmpDir: string;
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      tmpDir = createTmpDir();
      stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      stderrSpy.mockRestore();
    });

    it('injects {parallel_ok: true} default for v1 profiles and emits migration log', () => {
      writeFileSync(join(tmpDir, 'legacy.json'), JSON.stringify(SAMPLE_PROFILE));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);
      const profile = store.get('test-api');
      expect(profile?.concurrency).toEqual({ parallel_ok: true });
      expect(profile?.output_volume).toBeUndefined();

      const logs = stderrSpy.mock.calls.flat().filter((s): s is string => typeof s === 'string');
      expect(logs.some(s => s.includes('profile "test-api" is v1'))).toBe(true);
    });

    it('does not migrate or log when profile is already v2', () => {
      const v2Profile: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'v2-api',
        concurrency: { parallel_ok: false, max_in_flight: 1 },
        output_volume: 'large',
        cost: { model: 'per_call', rate_usd: 0.0006 },
        provenance: { source: 'manual', schema_version: 2 },
      };
      writeFileSync(join(tmpDir, 'v2.json'), JSON.stringify(v2Profile));
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);

      const profile = store.get('v2-api');
      expect(profile?.concurrency?.parallel_ok).toBe(false);
      expect(profile?.concurrency?.max_in_flight).toBe(1);
      expect(profile?.output_volume).toBe('large');
      expect(profile?.cost?.rate_usd).toBe(0.0006);
      expect(profile?.provenance?.schema_version).toBe(2);

      const logs = stderrSpy.mock.calls.flat().filter((s): s is string => typeof s === 'string');
      expect(logs.some(s => s.includes('is v1'))).toBe(false);
    });

    it('preserves explicit v1 concurrency override even without provenance', () => {
      const profileWithConcurrency: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'pinned',
        concurrency: { parallel_ok: false },
      };
      writeFileSync(join(tmpDir, 'pinned.json'), JSON.stringify(profileWithConcurrency));
      store.loadFromDirectory(tmpDir);

      const profile = store.get('pinned');
      expect(profile?.concurrency?.parallel_ok).toBe(false);
    });

    it('loads the reference DataForSEO v2 profile from examples/', () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const refPath = resolve(here, '../../examples/api-profiles/dataforseo.v2.json');
      const raw = readFileSync(refPath, 'utf-8');
      const profile = JSON.parse(raw) as ApiProfile;

      writeFileSync(join(tmpDir, 'dataforseo.json'), raw);
      const loaded = store.loadFromDirectory(tmpDir);
      expect(loaded).toBe(1);

      expect(profile.concurrency?.parallel_ok).toBe(false);
      expect(profile.auth?.type).toBe('basic');
      expect(profile.auth?.basic_format).toBe('pre_encoded_b64');
      expect(profile.cost?.model).toBe('per_call');
      expect(profile.output_volume).toBe('large');
      expect(profile.provenance?.schema_version).toBe(2);

      const logs = stderrSpy.mock.calls.flat().filter((s): s is string => typeof s === 'string');
      expect(logs.some(s => s.includes('is v1'))).toBe(false);
    });
  });

  describe('formatProfile v2 fields', () => {
    beforeEach(() => { store = new ApiStore(); });

    it('renders concurrency, output_volume, cost, provenance, vault_keys, basic_format', () => {
      const p: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'rendered',
        auth: {
          type: 'basic',
          basic_format: 'pre_encoded_b64',
          vault_keys: ['DATAFORSEO_TOKEN'],
        },
        concurrency: { parallel_ok: false, max_in_flight: 1, batchable_via_endpoint: '/v3/batch' },
        output_volume: 'large',
        cost: { model: 'per_call', rate_usd: 0.0006 },
        provenance: {
          source: 'manual',
          source_url: 'https://docs.example.com',
          validated_at: '2026-05-14T22:30:00Z',
          schema_version: 2,
        },
      };
      store.register(p);
      const out = store.formatProfile(store.get('rendered')!);
      expect(out).toContain('pre-encoded Base64');
      expect(out).toContain('DATAFORSEO_TOKEN');
      expect(out).toContain('parallel_ok=false');
      expect(out).toContain('max_in_flight: 1');
      expect(out).toContain('batchable_via_endpoint: /v3/batch');
      expect(out).toContain('Output volume: large');
      expect(out).toContain('Cost: per_call @ $0.0006');
      expect(out).toContain('source=manual');
      expect(out).toContain('schema_version=2');
    });

    it('renders oauth2 auth label without leaking vault_keys when absent', () => {
      const p: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'oauth-render',
        auth: { type: 'oauth2', vault_keys: ['GOOGLE_REFRESH_TOKEN'] },
      };
      store.register(p);
      const out = store.formatProfile(store.get('oauth-render')!);
      expect(out).toContain('OAuth2');
      expect(out).toContain('GOOGLE_REFRESH_TOKEN');
    });

    it('renders auth.type "none" as the explicit public-API label', () => {
      const p: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'public-render',
        auth: { type: 'none' },
      };
      store.register(p);
      const out = store.formatProfile(store.get('public-render')!);
      expect(out).toContain('None (public API');
      expect(out).not.toContain('vault keys');
      expect(out).not.toContain('Bearer');
    });

    // `basic_format` is OPTIONAL — validated only when present, and `api_setup
    // bootstrap` writes it only if the docs extraction produced one. A profile
    // without it used to render "the ENGINE attaches it from the stored username +
    // password. Do NOT set an Authorization header yourself", because the branch
    // tested for `pre_encoded_b64` and swept everything else into the engine-managed
    // sentence. http.ts attaches nothing for that shape, and a test pins it ("does
    // NOT attach for a bare basic profile with no basic_format"). So the profile the
    // product shipped instructed the model to omit the one header nobody else would
    // set — the only one of the three model-owned shapes that misleads rather than
    // merely staying silent.
    it('a basic profile with NO basic_format is not told the engine attaches it', () => {
      const p: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'bare-basic',
        auth: { type: 'basic', vault_keys: ['SOME_B64'] },
      };
      store.register(p);
      const out = store.formatProfile(store.get('bare-basic')!);
      expect(out).not.toMatch(/Do NOT set an Authorization header yourself/);
      expect(out).not.toMatch(/the ENGINE attaches it/);
      expect(out).toContain('no basic_format recorded');
      // NOT `toContain('yours to set')` — the first cut used exactly that, and
      // "the header is NOT yours to set" satisfies it. The shipped defect could be
      // reinstated word for word with all three asserts green. A substring assert on
      // a sentence whose negation contains the substring pins the letters, not the claim.
      expect(out).toContain('the engine attaches NOTHING here');
      // The ACTIONABLE half, which nothing pinned: both recovery clauses could be
      // deleted outright and the test stayed green.
      expect(out).toContain('Authorization: Basic secret:<VAULT_KEY>');
      expect(out).toContain('set auth.basic_format="user_pass_split"');
    });

    it('user_pass_split keeps the engine-attaches sentence — it is true for that one', () => {
      const p: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'split-basic',
        auth: { type: 'basic', basic_format: 'user_pass_split', username_key: 'U', password_key: 'P' },
      };
      store.register(p);
      const out = store.formatProfile(store.get('split-basic')!);
      expect(out).toContain('the ENGINE attaches it');
      expect(out).toContain('Do NOT set an Authorization header yourself');
    });

    it('pre_encoded_b64 says outright that the engine does not attach it', () => {
      const p: ApiProfile = {
        ...SAMPLE_PROFILE,
        id: 'pre-b64',
        auth: { type: 'basic', basic_format: 'pre_encoded_b64', vault_keys: ['SOME_B64'] },
      };
      store.register(p);
      const out = store.formatProfile(store.get('pre-b64')!);
      expect(out).toContain('the engine does not attach it');
      expect(out).not.toMatch(/the ENGINE attaches it/);
      // Same gap as above: the instruction that tells the model what to actually DO
      // could be replaced with anything at all.
      expect(out).toContain('set `Authorization: Basic secret:<VAULT_KEY>` yourself, as-is');
    });
  });

  describe('formatSuggestedApisForSystemPrompt', () => {
    beforeEach(() => { store = new ApiStore(); });

    /**
     * Split the rendered block into its headed sections.
     *
     * Exists because the assertion it replaces was `toContain('authorization_code')`
     * over the WHOLE block — which stays green if that flow moves from "NOT
     * supported" to "Supported", i.e. if the statement to the model inverts.
     * A guard that counts a string cannot see the heading it lives under, and
     * the heading is the entire meaning here.
     */
    function sectionsOf(block: string): Map<string, string[]> {
      const headings = new Map<string, string>([
        ['Supported auth flows:', 'supported'],
        ['NOT supported (cannot be bootstrapped today — do not offer):', 'not-supported'],
        ['Do NOT proactively suggest bootstrapping:', 'do-not-suggest'],
      ]);
      const out = new Map<string, string[]>();
      let current: string | null = null;
      for (const line of block.split('\n')) {
        const key = headings.get(line.trim());
        if (key !== undefined) { current = key; out.set(key, []); continue; }
        // A section runs until the blank line the renderer pushes after it.
        if (line.trim() === '') { current = null; continue; }
        if (current !== null && line.startsWith('- ')) out.get(current)!.push(line.slice(2));
      }
      return out;
    }

    it('renders the compiled catalogue with auth-constraint sections', () => {
      const out = store.formatSuggestedApisForSystemPrompt();

      // Wrapper tags so the agent can locate the block.
      expect(out).toContain('<api_bootstrap_hints>');
      expect(out).toContain('</api_bootstrap_hints>');

      // Capability + constraint sections.
      expect(out).toContain('api_setup');
      expect(out).toContain('Supported auth flows');
      expect(out).toContain('NOT supported');
      expect(out).toContain('Do NOT proactively suggest');

      // At least one curated API entry renders with its docs URL.
      expect(out).toContain('Open-Meteo');
      expect(out).toContain('https://open-meteo.com/en/docs');
    });

    it('places authorization_code under NOT-supported, and an inversion fails the test', () => {
      const sections = sectionsOf(store.formatSuggestedApisForSystemPrompt());

      const notSupported = sections.get('not-supported') ?? [];
      const supported = sections.get('supported') ?? [];
      expect(notSupported.length).toBeGreaterThan(0);
      expect(supported.length).toBeGreaterThan(0);

      // The claim, tied to its heading: oauth2 authorization_code is NOT in
      // ApiAuth.type, so the agent must be told it cannot bootstrap
      // browser-redirect-callback OAuth APIs.
      expect(notSupported.some((l) => l.toLowerCase().includes('authorization_code'))).toBe(true);
      expect(supported.some((l) => l.toLowerCase().includes('authorization_code'))).toBe(false);

      // Mutation witness for the splitter itself: were `sectionsOf` to return
      // every line under every key, the two asserts above would contradict each
      // other and could not both hold. This pins that the sections are disjoint.
      for (const line of notSupported) expect(supported).not.toContain(line);
    });

    /**
     * The two sentences that tell the model HOW to use the tool, and the one
     * that tells it to ask first. They survived a mutation round untouched:
     * the whole closing instruction could be inverted to "bootstrap
     * immediately without asking" with every assertion green, because the only
     * thing pinned was the substring `api_setup`, which also occurs elsewhere
     * in the block. An instruction in the briefing is a rule the model learns;
     * it needs an assert of its own.
     */
    it('keeps the instructions the block exists to give', () => {
      const out = store.formatSuggestedApisForSystemPrompt();
      expect(out).toContain('do NOT hand-write a profile from memory');
      expect(out).toContain('extracted from the live docs at bootstrap time');
      expect(out).toContain('ask first');
      expect(out).toContain('never silently bootstrap');
    });

    it('keeps the sections in order: supported, then not-supported, then do-not-suggest', () => {
      const out = store.formatSuggestedApisForSystemPrompt();
      const at = (heading: string): number => {
        const i = out.indexOf(heading);
        expect(i, `heading not found: ${heading}`).toBeGreaterThan(-1);
        return i;
      };
      const supported = at('Supported auth flows:');
      const notSupported = at('NOT supported (cannot be bootstrapped today');
      const doNot = at('Do NOT proactively suggest bootstrapping:');
      const curated = at('Curated free APIs you can offer to bootstrap');
      expect(supported).toBeLessThan(notSupported);
      expect(notSupported).toBeLessThan(doNot);
      expect(doNot).toBeLessThan(curated);

      // The blank line before a heading is not layout. Without it the heading
      // follows a `- ` bullet directly, which markdown reads as a lazy
      // continuation OF that bullet — so "Do NOT proactively suggest" would
      // arrive as part of the last not-supported item, and the offer list as
      // part of the last prohibition. Reported as a harmless survivor in the
      // first mutation round; it is not.
      expect(out).toContain('\n\nNOT supported (cannot be bootstrapped today');
      expect(out).toContain('\n\nDo NOT proactively suggest bootstrapping:');
      expect(out).toContain('\n\nCurated free APIs you can offer to bootstrap');
    });

    it('names payment and hosting in the do-not-suggest section specifically', () => {
      const doNot = sectionsOf(store.formatSuggestedApisForSystemPrompt()).get('do-not-suggest') ?? [];
      expect(doNot.length).toBe(SUGGESTED_API_CATALOG.do_not_proactively_suggest.length);
      expect(doNot.some((l) => l.toLowerCase().includes('payment'))).toBe(true);
      expect(doNot.some((l) => l.toLowerCase().includes('hosting'))).toBe(true);
      // The third clause is the general one, and it is the one that covers a
      // provider nobody thought to name. Two substrings left it droppable.
      expect(doNot.some((l) => l.toLowerCase().includes('billing'))).toBe(true);
      expect(doNot.some((l) => l.toLowerCase().includes('customer records'))).toBe(true);
    });

    it('returns empty string when LYNOX_SKIP_SUGGESTED_APIS=1', () => {
      const prior = process.env['LYNOX_SKIP_SUGGESTED_APIS'];
      process.env['LYNOX_SKIP_SUGGESTED_APIS'] = '1';
      try {
        expect(store.formatSuggestedApisForSystemPrompt()).toBe('');
      } finally {
        if (prior === undefined) delete process.env['LYNOX_SKIP_SUGGESTED_APIS'];
        else process.env['LYNOX_SKIP_SUGGESTED_APIS'] = prior;
      }
    });

    it('catalogue validates: every entry has id + name + category + docs_url + auth_type + value_prop', () => {
      expect(SUGGESTED_API_CATALOG.supported_auth_flows.length).toBeGreaterThan(0);
      expect(SUGGESTED_API_CATALOG.do_not_proactively_suggest.length).toBeGreaterThan(0);
      expect(SUGGESTED_API_CATALOG.suggested_apis.length).toBeGreaterThan(0);

      const ids = new Set<string>();
      for (const api of SUGGESTED_API_CATALOG.suggested_apis) {
        expect(api.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
        expect(api.name).toBeTruthy();
        expect(api.category).toBeTruthy();
        expect(api.docs_url).toMatch(/^https:\/\//);
        expect(api.auth_type).toBeTruthy();
        expect(api.value_prop).toBeTruthy();
        expect(ids.has(api.id)).toBe(false);
        ids.add(api.id);
      }
    });

    /**
     * The catalogue, written out rather than derived — and not just the ids.
     *
     * Deriving the expectation from SUGGESTED_API_CATALOG is the comfortable
     * version and it is worthless: delete an entry and the expectation shrinks
     * with it. Measured, not assumed — removing `vatcomply` left every
     * assertion in this suite green until this list existed.
     *
     * Two fields, because those two carry a claim about a third party rather
     * than prose about it:
     *   `docs_url`   — load-bearing. `api_setup` action=bootstrap extracts the
     *                  auth shape and endpoints from THIS page at run time, so
     *                  a wrong URL is a wrong profile, not a cosmetic slip.
     *   `auth_type`  — what the model is told the provider wants.
     * `name`, `category` and `value_prop` stay unpinned on purpose: they are
     * prose, and pinning prose in a test buys churn, not safety.
     */
    const EXPECTED_ENTRIES: ReadonlyArray<readonly [string, string, string]> = [
      ['hackernews', 'https://hn.algolia.com/api', 'none'],
      ['github', 'https://docs.github.com/en/rest', 'none'],
      ['npm', 'https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md', 'none'],
      ['wikipedia', 'https://www.mediawiki.org/wiki/API:Main_page', 'none'],
      ['arxiv', 'https://info.arxiv.org/help/api/index.html', 'none'],
      ['open-meteo', 'https://open-meteo.com/en/docs', 'none'],
      ['frankfurter', 'https://frankfurter.dev/', 'none'],
      ['restcountries', 'https://restcountries.com/', 'none'],
      ['nager-date', 'https://date.nager.at/Api', 'none'],
      ['vatcomply', 'https://www.vatcomply.com/documentation', 'none'],
    ];
    const EXPECTED_IDS = EXPECTED_ENTRIES.map(([id]) => id);

    it('carries exactly the catalogue entries this test names, with their docs URL and auth type', () => {
      const actual = SUGGESTED_API_CATALOG.suggested_apis
        .map((a) => [a.id, a.docs_url, a.auth_type] as const)
        .slice()
        .sort((x, y) => x[0].localeCompare(y[0]));
      const expected = EXPECTED_ENTRIES.slice().sort((x, y) => x[0].localeCompare(y[0]));
      expect(actual).toEqual(expected);
    });

    /**
     * Every field lands in a one-line list entry inside the fence. `renderFence`
     * neutralises a closing tag, and nothing else — a newline inside a field
     * opens a fresh paragraph in the briefing, which reads as text of its own
     * rather than as part of an entry. Matters most for entries describing a
     * third party, where the wording is copied from somewhere else.
     */
    it('no catalogue field contains a line break', () => {
      for (const api of SUGGESTED_API_CATALOG.suggested_apis) {
        for (const [field, value] of Object.entries(api)) {
          expect(value, `${api.id}.${field} contains a line break`).not.toMatch(/[\r\n]/);
        }
      }
      for (const s of [
        ...SUGGESTED_API_CATALOG.supported_auth_flows,
        ...SUGGESTED_API_CATALOG.not_supported_auth_flows,
        ...SUGGESTED_API_CATALOG.do_not_proactively_suggest,
      ]) {
        expect(s).not.toMatch(/[\r\n]/);
      }
    });

    it('renders every catalogue entry and nothing else', () => {
      const out = store.formatSuggestedApisForSystemPrompt();
      const rendered = out.split('\n').filter((l) => l.includes(', auth=') && l.startsWith('- '));
      expect(rendered.length).toBe(EXPECTED_IDS.length);
      for (const api of SUGGESTED_API_CATALOG.suggested_apis) {
        expect(out).toContain(`- ${api.name} (${api.category}, auth=${api.auth_type}) — ${api.value_prop} Docs: ${api.docs_url}`);
      }
    });

    /**
     * The point of moving the catalogue into code, as a behaviour rather than
     * a claim: a file at the path the old reader used must not reach the
     * briefing. Without this, "it comes from the constant now" is only true
     * until someone reinstates a fallback, and a fallback is exactly what hid
     * the shipping gap for a year.
     *
     * Two things this had to get right, both found by review:
     *  • It plants a file inside the repository. The first cut removed the
     *    whole `data/` directory in its `finally` while only checking that the
     *    FILE was absent beforehand — so a developer's own untracked `data/`,
     *    or a future one holding something else, would have been wiped by
     *    running the tests. It now removes what it created and nothing else.
     *  • Rendering once and comparing proves only that nothing is read at CALL
     *    time. A reader that ran at module load would have passed, because the
     *    module was already loaded when the file appeared. So the second half
     *    resets the module registry and imports again with the file in place.
     */
    it('ignores a catalogue file planted at the old path, at call time and at load time', async () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const oldPath = resolve(here, '../../data/suggested-apis.json');
      const oldDir = dirname(oldPath);
      // Loud rather than skipped: if this exists, the deletion was undone and
      // the test below would be measuring the wrong thing.
      expect(existsSync(oldPath)).toBe(false);
      const dirExisted = existsSync(oldDir);

      const before = store.formatSuggestedApisForSystemPrompt();
      if (!dirExisted) mkdirSync(oldDir, { recursive: true });
      try {
        writeFileSync(oldPath, JSON.stringify({
          supported_auth_flows: ['planted flow'],
          not_supported_auth_flows: [],
          do_not_proactively_suggest: ['planted restriction'],
          suggested_apis: [{
            id: 'planted', name: 'Planted API', category: 'planted',
            docs_url: 'https://planted.example/docs', auth_type: 'bearer',
            value_prop: 'Should never reach the briefing.',
          }],
        }), 'utf-8');

        // Call time.
        const atCallTime = new ApiStore().formatSuggestedApisForSystemPrompt();
        expect(atCallTime).toBe(before);

        // Load time — the module graph is re-evaluated with the file present.
        vi.resetModules();
        const reloaded = await import('./api-store.js');
        const atLoadTime = new reloaded.ApiStore().formatSuggestedApisForSystemPrompt();
        expect(atLoadTime).toBe(before);
        expect(atLoadTime).not.toContain('Planted API');
        expect(atLoadTime).not.toContain('planted flow');
        expect(atLoadTime).not.toContain('planted restriction');
      } finally {
        rmSync(oldPath, { force: true });
        // Only the directory this test created, and only while it is empty.
        // `rmdirSync`, not `rmSync`: it refuses a non-empty directory, so the
        // emptiness check has a second opinion that is not this test's own.
        if (!dirExisted && existsSync(oldDir) && readdirSync(oldDir).length === 0) {
          rmdirSync(oldDir);
        }
        vi.resetModules();
      }
    });

    /**
     * All five collections and an entry, not the outer object and one array:
     * a review pointed out that dropping `Object.freeze` from the three
     * auth-flow lists and from each entry left the suite green.
     */
    it('no part of the catalogue constant can be rewritten at runtime', () => {
      expect(() => {
        (SUGGESTED_API_CATALOG as { suggested_apis: unknown }).suggested_apis = [];
      }).toThrow(TypeError);

      const arrays: ReadonlyArray<readonly [string, readonly unknown[]]> = [
        ['suggested_apis', SUGGESTED_API_CATALOG.suggested_apis],
        ['supported_auth_flows', SUGGESTED_API_CATALOG.supported_auth_flows],
        ['not_supported_auth_flows', SUGGESTED_API_CATALOG.not_supported_auth_flows],
        ['do_not_proactively_suggest', SUGGESTED_API_CATALOG.do_not_proactively_suggest],
      ];
      for (const [name, arr] of arrays) {
        expect(Object.isFrozen(arr), `${name} is not frozen`).toBe(true);
        expect(() => (arr as unknown[]).push('x'), name).toThrow(TypeError);
      }

      for (const entry of SUGGESTED_API_CATALOG.suggested_apis) {
        expect(Object.isFrozen(entry), `entry ${entry.id} is not frozen`).toBe(true);
        expect(() => {
          (entry as { docs_url: string }).docs_url = 'https://evil.example/';
        }, entry.id).toThrow(TypeError);
      }
    });
  });
});

describe('vault slot derivation — one function, and it must stay injective at the gate', () => {
  function profile(id: string): ApiProfile {
    return {
      id,
      name: id,
      base_url: `https://${id.replace(/[_-]/g, '')}.example.com`,
      description: 'fixture',
      auth: { type: 'oauth2', vault_keys: [], oauth: { token_url: 'https://t.example.com/tok' } },
      endpoints: [{ method: 'GET', path: '/x', description: 'x' }],
    } as unknown as ApiProfile;
  }

  it('derives the same slot for ids that differ only in - vs _', () => {
    // Not a defect in itself — it is the PREMISE of the guard below, asserted so
    // that a future change to the derivation makes the guard's reason visible
    // instead of leaving a test that guards nothing.
    expect(vaultSlotBase('x-y')).toBe('X_Y');
    expect(vaultSlotBase('x_y')).toBe('X_Y');
    expect(accessTokenKey('x-y')).toBe(accessTokenKey('x_y'));
    expect(refreshTokenKey('x-y')).toBe(refreshTokenKey('x_y'));
  });

  it('refuses to register a second profile that lands on a slot another id holds', () => {
    const store = new ApiStore();
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    store.register(profile('x-y'));
    store.register(profile('x_y'));

    // The first keeps the slot; the second is refused rather than admitted next
    // to it. Admitting both is the defect: the later mint overwrites the earlier
    // profile's token and the attach then hands ONE credential to TWO hosts.
    expect(store.get('x-y')).toBeDefined();
    expect(store.get('x_y')).toBeUndefined();
    expect(warn.mock.calls.map((c) => String(c[0])).join('')).toMatch(/vault slot/i);
    warn.mockRestore();
  });

  it('still allows re-registering the SAME id — the guard is about neighbours, not updates', () => {
    const store = new ApiStore();
    store.register(profile('x-y'));
    const updated = { ...profile('x-y'), description: 'second write' };
    store.register(updated);

    expect(store.get('x-y')?.description).toBe('second write');
  });

  it('save reports the refusal instead of reporting a create', () => {
    const store = new ApiStore();
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    store.save(profile('x-y'));

    const second = store.save(profile('x_y'));

    // The refusal used to arrive as `isNew: true` — indistinguishable from a
    // successful create, so the caller reported one. Fail-closed in effect,
    // false-confident in report.
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toMatch(/already holds|derives the vault slot/i);
    expect(store.get('x_y')).toBeUndefined();
    warn.mockRestore();
  });

  it('loadFromDirectory counts registrations, not files, and admits the pair deterministically', () => {
    const dir = createTmpDir();
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Written in the order that would let an unsorted read pick either one.
    writeFileSync(join(dir, 'zz.json'), JSON.stringify(profile('x_y')));
    writeFileSync(join(dir, 'aa.json'), JSON.stringify(profile('x-y')));

    const store = new ApiStore();
    const loaded = store.loadFromDirectory(dir);

    // One landed, so one is counted — a count of 2 would report a profile that
    // is not in the store.
    expect(loaded).toBe(1);
    // And it is always the same one: file order is sorted, so `aa.json` wins on
    // every boot instead of whichever the filesystem happened to hand back.
    expect(store.get('x-y')).toBeDefined();
    expect(store.get('x_y')).toBeUndefined();
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves non-colliding ids alone', () => {
    const store = new ApiStore();
    store.register(profile('alpha'));
    store.register(profile('beta'));

    expect(store.get('alpha')).toBeDefined();
    expect(store.get('beta')).toBeDefined();
  });
});
