import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We mock node:os and node:process to control homedir and cwd
const tmpBase = mkdtempSync(join(tmpdir(), 'lynox-config-'));
const fakeHome = join(tmpBase, 'home');
const fakeProject = join(tmpBase, 'project');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fakeProject, { recursive: true });

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

const originalCwd = process.cwd;

describe('Config', () => {
  beforeEach(() => {
    process.cwd = () => fakeProject;
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['LYNOX_WORKSPACE'];
    delete process.env['LYNOX_EMBEDDING_PROVIDER'];
    delete process.env['LYNOX_USER'];
    delete process.env['LYNOX_ORG'];
    delete process.env['LYNOX_CLIENT'];
    delete process.env['GOOGLE_CLIENT_ID'];
    delete process.env['GOOGLE_CLIENT_SECRET'];
    delete process.env['TAVILY_API_KEY'];
    delete process.env['SEARXNG_URL'];
    delete process.env['LYNOX_WORKER_PROFILE'];
    delete process.env['LYNOX_MODEL_PROFILES_JSON'];
    delete process.env['LYNOX_ACCOUNT_TIER'];
    delete process.env['MISTRAL_API_KEY'];
    delete process.env['LYNOX_LLM_PROVIDER'];
    delete process.env['LYNOX_SUBJECT_GRAPH_ENABLED'];
    delete process.env['LYNOX_NETWORK_POLICY'];
    delete process.env['LYNOX_NETWORK_ALLOWED_HOSTS'];
    // Renamed vars (canonical + legacy) — keep both clean so alias tests don't leak
    delete process.env['LYNOX_API_BASE_URL'];
    delete process.env['LYNOX_MAX_TIER'];
    delete process.env['LYNOX_MAX_MODEL_TIER'];
    delete process.env['LYNOX_DEFAULT_TIER'];
    delete process.env['LYNOX_DEFAULT_MODEL_TIER'];
    delete process.env['LYNOX_DATA_DIR'];
    delete process.env['LYNOX_DIR'];
    // Clean up any config files from previous tests
    rmSync(join(fakeHome, '.lynox'), { recursive: true, force: true });
    rmSync(join(fakeProject, '.lynox'), { recursive: true, force: true });
    vi.resetModules();
  });

  afterEach(() => {
    process.cwd = originalCwd;
  });

  it('returns empty config when no files exist', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('loads user-level config', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ default_tier: 'balanced', effort_level: 'high' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.default_tier).toBe('balanced');
    expect(config.effort_level).toBe('high');
  });

  it('project config overrides user config', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ default_tier: 'deep', effort_level: 'high' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ default_tier: 'balanced' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.default_tier).toBe('balanced');
    expect(config.effort_level).toBe('high');
  });

  it('env vars override config files', async () => {
    const userDir = join(fakeHome, '.lynox');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ api_key: 'sk-from-file' }));

    process.env['ANTHROPIC_API_KEY'] = 'sk-from-env';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_key).toBe('sk-from-env');
  });

  it('keeps network_policy + network_allowed_hosts from config.json (not stripped by .strict())', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      network_policy: 'allow-list',
      network_allowed_hosts: ['api.example.com', '*.internal.example.com'],
    }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.network_policy).toBe('allow-list');
    expect(config.network_allowed_hosts).toEqual(['api.example.com', '*.internal.example.com']);
  });

  it('rejects an invalid network_policy enum (whole config nulled by .strict())', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    // A bad enum fails safeParse → readConfigFile returns null → empty config.
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      default_tier: 'balanced',
      network_policy: 'open-everything',
    }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.network_policy).toBeUndefined();
    expect(config.default_tier).toBeUndefined();
  });

  it('reads network_policy + allowed hosts from env (CP injection path)', async () => {
    process.env['LYNOX_NETWORK_POLICY'] = 'deny-all';
    process.env['LYNOX_NETWORK_ALLOWED_HOSTS'] = 'api.example.com, *.cdn.example.com ,';

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.network_policy).toBe('deny-all');
    // trimmed, empty segments dropped
    expect(config.network_allowed_hosts).toEqual(['api.example.com', '*.cdn.example.com']);
  });

  it('ignores an unrecognised LYNOX_NETWORK_POLICY value', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ network_policy: 'allow-list' }));
    process.env['LYNOX_NETWORK_POLICY'] = 'bogus';

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    // env value rejected → config.json value retained, never coerced
    expect(config.network_policy).toBe('allow-list');
  });

  it('saveUserConfig writes with 0600 permissions', async () => {
    const { saveUserConfig } = await import('./config.js');
    saveUserConfig({ api_key: 'sk-test-123', default_tier: 'fast' });

    const filePath = join(fakeHome, '.lynox', 'config.json');
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.api_key).toBe('sk-test-123');
    expect(content.default_tier).toBe('fast');

    const stats = statSync(filePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('hasApiKey detects env var', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const { hasApiKey } = await import('./config.js');
    expect(hasApiKey()).toBe(true);
  });

  it('hasApiKey detects config file', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ api_key: 'sk-test' }));

    const { hasApiKey } = await import('./config.js');
    expect(hasApiKey()).toBe(true);
  });

  it('hasApiKey returns false when no key', async () => {
    const { hasApiKey } = await import('./config.js');
    expect(hasApiKey()).toBe(false);
  });

  it('handles malformed JSON gracefully', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), 'not json');

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('ANTHROPIC_BASE_URL env overrides config', async () => {
    process.env['ANTHROPIC_BASE_URL'] = 'http://localhost:3042';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_base_url).toBe('http://localhost:3042');
  });

  it('LYNOX_API_BASE_URL (canonical) sets api_base_url', async () => {
    process.env['LYNOX_API_BASE_URL'] = 'https://api.mistral.ai/v1';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_base_url).toBe('https://api.mistral.ai/v1');
  });

  it('LYNOX_API_BASE_URL wins over the legacy ANTHROPIC_BASE_URL when both are set', async () => {
    process.env['LYNOX_API_BASE_URL'] = 'https://canonical.example/v1';
    process.env['ANTHROPIC_BASE_URL'] = 'https://legacy.example/v1';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_base_url).toBe('https://canonical.example/v1');
  });

  it('LYNOX_MAX_MODEL_TIER (canonical) and the legacy LYNOX_MAX_TIER both set max_tier', async () => {
    process.env['LYNOX_MAX_MODEL_TIER'] = 'deep';
    const canonical = (await import('./config.js')).loadConfig();
    expect(canonical.max_tier).toBe('deep');

    vi.resetModules();
    delete process.env['LYNOX_MAX_MODEL_TIER'];
    process.env['LYNOX_MAX_TIER'] = 'opus'; // legacy brand value, still accepted
    const legacy = (await import('./config.js')).loadConfig();
    expect(legacy.max_tier).toBe('deep');
  });

  it('LYNOX_MAX_MODEL_TIER wins over the legacy LYNOX_MAX_TIER when both are set', async () => {
    process.env['LYNOX_MAX_MODEL_TIER'] = 'fast';
    process.env['LYNOX_MAX_TIER'] = 'deep';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().max_tier).toBe('fast');
  });

  it('LYNOX_DEFAULT_MODEL_TIER (canonical) and the legacy LYNOX_DEFAULT_TIER both set default_tier', async () => {
    process.env['LYNOX_DEFAULT_MODEL_TIER'] = 'balanced';
    const canonical = (await import('./config.js')).loadConfig();
    expect(canonical.default_tier).toBe('balanced');

    vi.resetModules();
    delete process.env['LYNOX_DEFAULT_MODEL_TIER'];
    process.env['LYNOX_DEFAULT_TIER'] = 'sonnet'; // legacy brand value
    const legacy = (await import('./config.js')).loadConfig();
    expect(legacy.default_tier).toBe('balanced');
  });

  it('project config cannot override api_key', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ api_key: 'sk-user-safe' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ api_key: 'sk-malicious-override' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_key).toBe('sk-user-safe');
  });

  it('project config cannot override api_base_url', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ api_base_url: 'https://safe.api.com' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ api_base_url: 'https://evil.api.com' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.api_base_url).toBe('https://safe.api.com');
  });

  it('project config can override safe fields', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ default_tier: 'deep', effort_level: 'high' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ default_tier: 'balanced', effort_level: 'max' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.default_tier).toBe('balanced');
    expect(config.effort_level).toBe('max');
  });

  it('saveUserConfig creates dir with 0700 permissions', async () => {
    const { saveUserConfig } = await import('./config.js');
    saveUserConfig({ default_tier: 'fast' });

    const dirStats = statSync(join(fakeHome, '.lynox'));
    expect(dirStats.mode & 0o777).toBe(0o700);
  });

  it('LYNOX_ORG env sets organization_id', async () => {
    process.env['LYNOX_ORG'] = 'acme';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.organization_id).toBe('acme');
  });

  it('LYNOX_CLIENT env sets client_id', async () => {
    process.env['LYNOX_CLIENT'] = 'client1';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.client_id).toBe('client1');
  });

  // ── Foundation Rework v2 (S1b): subject-graph flag (deploy wiring) ──────────

  it('LYNOX_SUBJECT_GRAPH_ENABLED env flips subject_graph_enabled (true/1, false/0)', async () => {
    process.env['LYNOX_SUBJECT_GRAPH_ENABLED'] = 'true';
    let { loadConfig } = await import('./config.js');
    expect(loadConfig().subject_graph_enabled).toBe(true);

    vi.resetModules();
    process.env['LYNOX_SUBJECT_GRAPH_ENABLED'] = '0';
    ({ loadConfig } = await import('./config.js'));
    expect(loadConfig().subject_graph_enabled).toBe(false);
  });

  it('subject_graph_enabled survives the .strict() config.json schema (not stripped)', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ subject_graph_enabled: true }));
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().subject_graph_enabled).toBe(true);
  });

  // ── Managed profile bridge (CP delivers worker/model profiles via env) ──────

  it('LYNOX_WORKER_PROFILE env sets worker_profile when its profile exists', async () => {
    process.env['LYNOX_WORKER_PROFILE'] = 'fallback';
    process.env['LYNOX_MODEL_PROFILES_JSON'] = JSON.stringify({
      // A well-formed profile carries api_base_url (a required ModelProfile field
      // the CP always emits); the isModelProfile guard now drops under-specified
      // entries rather than letting them reach the openai-adapter.
      fallback: { provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', api_key: 'sk-x', model_id: 'mistral-large-2512' },
    });
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().worker_profile).toBe('fallback');
  });

  it('clears a dangling worker_profile whose model profile is missing (avoids per-task throw)', async () => {
    // worker_profile names a profile the profiles blob never provided (e.g. a
    // malformed/dropped JSON or drifted env) — must NOT survive, else every
    // background task throws "Unknown model profile".
    process.env['LYNOX_WORKER_PROFILE'] = 'fallback';
    process.env['LYNOX_MODEL_PROFILES_JSON'] = '{ not valid json';
    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig();
    expect(cfg.worker_profile).toBeUndefined();
    expect(cfg.model_profiles).toBeUndefined();
  });

  it('LYNOX_MODEL_PROFILES_JSON env deserializes into model_profiles', async () => {
    process.env['LYNOX_MODEL_PROFILES_JSON'] = JSON.stringify({
      fallback: { provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', api_key: 'sk-x', model_id: 'mistral-large-2512' },
    });
    const { loadConfig } = await import('./config.js');
    const profiles = loadConfig().model_profiles;
    expect(profiles?.['fallback']).toMatchObject({ provider: 'openai', model_id: 'mistral-large-2512' });
  });

  it('drops a malformed profile entry (missing api_key) but keeps valid siblings', async () => {
    // The blind `as` cast used to pass an entry with no api_key straight to the
    // openai-adapter, which crashes the run with `Authorization: Bearer undefined`.
    // The isModelProfile guard now filters per-entry: the valid sibling survives.
    process.env['LYNOX_MODEL_PROFILES_JSON'] = JSON.stringify({
      good: { provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', api_key: 'sk-x', model_id: 'mistral-large-2512' },
      bad: { provider: 'openai', model_id: 'mistral-large-2512' }, // no api_key
    });
    const { loadConfig } = await import('./config.js');
    const profiles = loadConfig().model_profiles;
    expect(profiles?.['good']).toBeDefined();
    expect(profiles?.['bad']).toBeUndefined();
  });

  it('malformed LYNOX_MODEL_PROFILES_JSON is ignored (boots without crashing)', async () => {
    process.env['LYNOX_MODEL_PROFILES_JSON'] = '{ not valid json';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().model_profiles).toBeUndefined();
  });

  it('an array (not an object) for LYNOX_MODEL_PROFILES_JSON is ignored', async () => {
    process.env['LYNOX_MODEL_PROFILES_JSON'] = JSON.stringify(['not', 'a', 'map']);
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().model_profiles).toBeUndefined();
  });

  // ── Managed Mistral key promotion (replaces the retired eu-sovereign axis) ──
  // The CP/UI stages provider='openai' + the Mistral api_base_url; the managed
  // MISTRAL_API_KEY lives only in the environment, so loadConfig flows it into
  // api_key. Keyed on provider+endpoint, not the old llm_mode toggle.

  const writeUserConfig = (cfg: Record<string, unknown>): void => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  };

  it('promotes MISTRAL_API_KEY even when ANTHROPIC_API_KEY already set api_key', async () => {
    // Blocker-1 regression: ANTHROPIC_API_KEY lands in merged.api_key first (every
    // managed/self-host box has it). The promotion MUST still win, else the in-app
    // Mistral switch calls api.mistral.ai with the Anthropic key → 401.
    writeUserConfig({ provider: 'openai', api_base_url: 'https://api.mistral.ai/v1' });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-xxx';
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-yyy';
    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig();
    expect(cfg.provider).toBe('openai');
    expect(cfg.api_key).toBe('sk-mistral-yyy');
    expect(cfg.openai_model_id).toBe('mistral-large-2512'); // default when none staged
  });

  it('keeps an explicitly staged openai_model_id instead of forcing the default', async () => {
    writeUserConfig({ provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', openai_model_id: 'mistral-medium-2505' });
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-yyy';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().openai_model_id).toBe('mistral-medium-2505');
  });

  it('does NOT promote for a non-Mistral openai endpoint (leaves user key intact)', async () => {
    writeUserConfig({ provider: 'openai', api_base_url: 'https://api.openai.com/v1', api_key: 'sk-user-own' });
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-yyy';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBe('sk-user-own');
  });

  it('does NOT promote for a spoofed Mistral host (api.mistral.ai.evil.com)', async () => {
    writeUserConfig({ provider: 'openai', api_base_url: 'https://api.mistral.ai.evil.com/v1' });
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-yyy';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBeUndefined();
  });

  it('leaves an anthropic-provider config untouched even with MISTRAL_API_KEY present', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-xxx';
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-yyy';
    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig();
    expect(cfg.provider).toBeUndefined(); // defaults to anthropic
    expect(cfg.api_key).toBe('sk-ant-xxx');
  });

  it('llm_mode=eu-sovereign alone no longer activates Mistral (axis retired, key tolerated)', async () => {
    // Blocker-2: the .strict() schema still tolerates the deprecated key so the
    // file parses (not nulled), but the engine no longer acts on it.
    writeUserConfig({ llm_mode: 'eu-sovereign' });
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-yyy';
    const { loadConfig } = await import('./config.js');
    const cfg = loadConfig();
    expect(cfg.provider).toBeUndefined();
    expect(cfg.api_key).toBeUndefined();
    expect(cfg.llm_mode).toBe('eu-sovereign'); // parsed, but inert
  });

  it('project config can override organization_id (safe key)', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ organization_id: 'user-org' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ organization_id: 'project-org' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.organization_id).toBe('project-org');
  });

  it('project config can override client_id (safe key)', async () => {
    const userDir = join(fakeHome, '.lynox');
    const projectDir = join(fakeProject, '.lynox');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ client_id: 'user-client' }));
    writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ client_id: 'project-client' }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.client_id).toBe('project-client');
  });
});
