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
    // Per-endpoint slots — without these, a key set by one case leaks into the
    // next and the endpoint-scoping assertions pass for the wrong reason.
    delete process.env['GROQ_API_KEY'];
    delete process.env['OLLAMA_API_KEY'];
    delete process.env['TOGETHER_API_KEY'];
    delete process.env['FIREWORKS_API_KEY'];
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
    delete process.env['LYNOX_MEMORY_GRAPH_READS'];
    delete process.env['LYNOX_MEMORY_SCORING_V2'];
    delete process.env['LYNOX_RETRIEVAL_SHADOW_LOG'];
    delete process.env['LYNOX_MEMORY_WRITE_TRUST_GATE'];
    delete process.env['LYNOX_DEBUG_WIRE_CAPTURE'];
    delete process.env['LYNOX_NETWORK_POLICY'];
    delete process.env['LYNOX_NETWORK_ALLOWED_HOSTS'];
    delete process.env['LYNOX_TIER_SET_JSON'];
    delete process.env['LYNOX_TIER_PRESET'];
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_BLOCKED_MODEL_IDS'];
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

  describe('model blocklist (LYNOX_BLOCKED_MODEL_IDS → blocked_model_ids)', () => {
    const writeUserConfig = (obj: Record<string, unknown>) => {
      const dir = join(fakeHome, '.lynox');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), JSON.stringify(obj));
    };

    it('parses the env var into blocked_model_ids (comma-separated prefixes, trimmed)', async () => {
      process.env['LYNOX_BLOCKED_MODEL_IDS'] = 'claude-sonnet-, claude-opus- ,claude-fable-';
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().blocked_model_ids).toEqual(['claude-sonnet-', 'claude-opus-', 'claude-fable-']);
    });

    it('unset env → no blocked_model_ids (byte-identical default path)', async () => {
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().blocked_model_ids).toBeUndefined();
    });

    it('drops a BLOCKED managed tier_set slot IN-MEMORY; config.json stays byte-identical', async () => {
      process.env['LYNOX_BILLING_TIER'] = 'managed';
      process.env['ANTHROPIC_API_KEY'] = 'cp-key';
      process.env['LYNOX_BLOCKED_MODEL_IDS'] = 'claude-opus-';
      writeUserConfig({
        routing_mode: 'hybrid',
        tier_set: {
          fast: { provider: 'anthropic', model_id: 'claude-haiku-4-5-20251001' },
          deep: { provider: 'anthropic', model_id: 'claude-opus-4-6' },
        },
      });
      const configPath = join(fakeHome, '.lynox', 'config.json');
      const bytesBefore = readFileSync(configPath, 'utf-8');
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_set?.deep).toBeUndefined(); // blocked slot dropped (falls back to base)
      expect(config.tier_set?.fast?.model_id).toBe('claude-haiku-4-5-20251001'); // allowed slot kept
      // Non-destructive clamp: the persisted user choice survives on disk, so
      // clearing the blocklist restores it on the next reload.
      expect(readFileSync(configPath, 'utf-8')).toBe(bytesBefore);
    });

    it('empty blocklist env leaves the managed tier_set untouched (no-op)', async () => {
      process.env['LYNOX_BILLING_TIER'] = 'managed';
      process.env['ANTHROPIC_API_KEY'] = 'cp-key';
      process.env['LYNOX_BLOCKED_MODEL_IDS'] = '';
      writeUserConfig({
        routing_mode: 'hybrid',
        tier_set: { deep: { provider: 'anthropic', model_id: 'claude-opus-4-6' } },
      });
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().tier_set?.deep?.model_id).toBe('claude-opus-4-6');
    });

    it('clears a worker_profile whose profile model is blocked (raw-id path guard)', async () => {
      process.env['LYNOX_WORKER_PROFILE'] = 'worker';
      process.env['LYNOX_MODEL_PROFILES_JSON'] = JSON.stringify({
        worker: { provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', api_key: 'k', model_id: 'claude-fable-5' },
      });
      process.env['LYNOX_BLOCKED_MODEL_IDS'] = 'claude-fable-';
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().worker_profile).toBeUndefined();
    });

    it('keeps a worker_profile whose model is NOT blocked', async () => {
      process.env['LYNOX_WORKER_PROFILE'] = 'worker';
      process.env['LYNOX_MODEL_PROFILES_JSON'] = JSON.stringify({
        worker: { provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', api_key: 'k', model_id: 'ministral-8b-2512' },
      });
      process.env['LYNOX_BLOCKED_MODEL_IDS'] = 'claude-fable-';
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().worker_profile).toBe('worker');
    });
  });

  describe('tier_preset expansion (model-presets W2)', () => {
    const writeUserConfig = (obj: Record<string, unknown>) => {
      const dir = join(fakeHome, '.lynox');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), JSON.stringify(obj));
    };

    it('expands a config.json tier_preset to routing_mode:hybrid + the SoT tier_set', async () => {
      writeUserConfig({ tier_preset: 'balanced' });
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.routing_mode).toBe('hybrid');
      // ⚖️ balanced is ⚡ efficient with a stronger main and NOTHING else changed —
      // assert all three slots, because that identity is the point of the pair: a
      // future edit that "upgrades" balanced's fast or deep slot silently reintroduces
      // the multi-variable difference this ladder was reshaped to remove (2026-08-10).
      expect(config.tier_set?.fast).toEqual({
        provider: 'openai',
        model_id: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        api_base_url: 'https://api.fireworks.ai/inference/v1',
      });
      expect(config.tier_set?.balanced).toEqual({
        provider: 'openai',
        model_id: 'accounts/fireworks/models/glm-5p2',
        api_base_url: 'https://api.fireworks.ai/inference/v1',
      });
      expect(config.tier_set?.deep).toEqual({
        provider: 'openai',
        model_id: 'accounts/fireworks/models/kimi-k3',
        api_base_url: 'https://api.fireworks.ai/inference/v1',
      });
    });

    it('an env LYNOX_TIER_SET_JSON slot overrides the preset per-slot (env wins)', async () => {
      writeUserConfig({ tier_preset: 'balanced' });
      process.env['LYNOX_TIER_SET_JSON'] = JSON.stringify({
        deep: { provider: 'openai', model_id: 'my-own-model', api_base_url: 'https://api.mistral.ai/v1' },
      });
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_set?.deep?.model_id).toBe('my-own-model'); // env slot won
      expect(config.tier_set?.balanced?.model_id).toBe('accounts/fireworks/models/glm-5p2'); // preset slot kept
    });

    it('a CP-pinned LYNOX_TIER_PRESET expands like a config.json one', async () => {
      // The reason this var exists: `LYNOX_MANAGED_FIREWORKS_ENABLED` only UNLOCKS
      // the Fireworks slot — nothing activated it, and the control plane had no way
      // to name a preset at all. A tenant therefore sat on the default Anthropic
      // routing while a paid-for, DPA-disclosed provider went unused.
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.routing_mode).toBe('hybrid');
      expect(config.tier_set?.deep?.api_base_url).toContain('fireworks');
    });

    it('an UNBACKED managed preset clears the NAME too, not just the slots', async () => {
      // `efficient` is all-Fireworks. On a managed instance without the credential,
      // `applyManagedTierSetConstraints` drops every slot and routing falls back to
      // standard — correct. What it used to leave behind was the NAME, so
      // `/api/config` and the strategy picker reported a preset as in effect while
      // every band ran on the base provider. Two of three presets exist precisely to
      // route away from that model, so the surface claimed the opposite of the bill.
      process.env['LYNOX_BILLING_TIER'] = 'managed';
      process.env['ANTHROPIC_API_KEY'] = 'cp-key';
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      delete process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'];
      delete process.env['FIREWORKS_API_KEY'];
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_set).toBeUndefined();
      expect(config.routing_mode).toBe('standard');
      expect(config.tier_preset).toBeUndefined();
    });

    it('a BACKED managed preset keeps both the slots and the name', async () => {
      // Counter-direction: the clear must fire on the dropped-to-empty case only.
      // Without this, deleting the name unconditionally would pass the test above.
      process.env['LYNOX_BILLING_TIER'] = 'managed';
      process.env['ANTHROPIC_API_KEY'] = 'cp-key';
      process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'] = '1';
      process.env['FIREWORKS_API_KEY'] = 'fw-key';
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBe('efficient');
      expect(config.routing_mode).toBe('hybrid');
      expect(config.tier_set?.deep?.api_base_url).toContain('fireworks');
    });

    it('a config.json preset WINS over the CP pin — it is a seed, not a lock', async () => {
      // INVERTED 2026-08-17. This test used to assert the opposite ("it is a lock,
      // not a seed"), on the argument that the preset picks the PROVIDER and the
      // provider set is DPA-disclosed + CP-paid, so a tenant must not route around
      // it. Measured on staging against a live pin, that argument did not survive:
      // a tenant writing explicit `tier_set` slots ALREADY beat the pin (the
      // expansion spreads config.json slots over the preset's), so the rule bound
      // only the settings picker — and there it failed silently, accepting the
      // write, persisting it, reporting it back, and then discarding it at load.
      //
      // Seeding is the intended semantic (rafael 2026-08-17). The counter-direction
      // — pin still applies when the tenant has NOT chosen — is the test below.
      writeUserConfig({ tier_preset: 'max-quality' });
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      // max-quality is all-Anthropic; efficient would have put Fireworks here.
      expect(config.tier_preset).toBe('max-quality');
      expect(config.tier_set?.balanced?.provider).toBe('anthropic');
      expect(config.tier_set?.deep?.api_base_url).toBeUndefined();
    });

    it('the pin RESCUES an unresolvable persisted preset instead of crash-looping', async () => {
      // While the pin overwrote, it masked any stale name in config.json. Seeding
      // removed that by accident and the cost was severe: retiring a preset from
      // TIER_PRESETS would throw at load for every tenant who had it persisted,
      // and `loadConfig()` in the engine ctor has no catch — so the container
      // crash-loops, and the settings UI needed to clear the value is served by
      // the container that will not boot. Measured on this branch before the fix:
      // `Unknown tier_preset "eu-sovereign"`.
      //
      // The name in this fixture is not arbitrary: `eu-sovereign` really was a
      // preset here and in TIER_PRESET_NAMES, added and withdrawn inside #1185
      // before it merged. So a name entering the shared vocabulary and leaving
      // again is a thing that has happened, caught by a review rather than by a
      // mechanism — which is the case the rescue exists for.
      //
      // (A `git log -S"'eu-sovereign':"` on tier-presets.ts comes back empty and
      // reads like proof it never existed. It is not: squash-merge collapses a
      // symbol added and removed within one PR. Dropping the quotes finds it.)
      writeUserConfig({ tier_preset: 'eu-sovereign' });
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBe('efficient');
      expect(config.tier_set?.deep?.api_base_url).toContain('fireworks');
    });

    it('an unresolvable persisted preset with NO pin BOOTS on default routing', async () => {
      // REVERSED 2026-08-17 (second time, and the direction is now consistent).
      // This asserted the throw, and a review showed the carve-out around it was
      // arbitrary: the no-pin case IS the motivating scenario — "retiring a preset
      // would crash-loop every tenant who had it persisted, with no way back" —
      // and since the pin is emitted only when set, most instances have none. The
      // guard reached everything except the case it was written for.
      //
      // The throw bought nothing here. An absent preset means the instance's own
      // default routing: no tier_set, no unregistered model, none of the
      // misbilling that justifies failing closed. It cost a container that will
      // not start, with the settings UI needed to fix it served by that container.
      writeUserConfig({ tier_preset: 'eu-sovereign' });
      delete process.env['LYNOX_TIER_PRESET'];
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBeUndefined();
      expect(config.tier_set).toBeUndefined();
    });

    it('drops an unresolvable persisted name even when the tenant chose their OWN routing', async () => {
      // The bug this restructure fixes. The drop used to sit inside the seed's
      // `else if`, which is unreachable once `choseOwnRouting` short-circuits the
      // arm above — and the settings writer plants `routing_mode` in config.json
      // permanently after any Standard/Custom pick. So the rescue was off for
      // exactly the tenants who use the picker most, WITH a valid pin sitting
      // right there. Measured before the fix: it threw.
      writeUserConfig({ routing_mode: 'standard', tier_preset: 'eu-sovereign' });
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBeUndefined();
    });

    it('a BLANK pin does not rescue — but the bad name is dropped, not fatal', async () => {
      // Still kills the `envPreset !== ''` guard: drop it and the blank pin would
      // be assigned over the bad name. What changed is the consequence — an
      // unresolvable persisted name no longer takes the boot with it.
      writeUserConfig({ tier_preset: 'eu-sovereign' });
      process.env['LYNOX_TIER_PRESET'] = '   ';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBeUndefined();
      expect(config.routing_mode).not.toBe('hybrid');
    });

    it('a BLANK config.json preset is not a choice — it neither wins nor throws', async () => {
      // `min(1)` lets "  " through the schema, and it is truthy, so it used to
      // suppress the seed AND reach the fail-closed expander: measured
      // `Unknown tier_preset "  "` on a container that booted fine before.
      writeUserConfig({ tier_preset: '  ' });
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBe('efficient');
    });

    it('a blank config.json preset with NO pin boots on standard routing, no throw', async () => {
      writeUserConfig({ tier_preset: '  ' });
      delete process.env['LYNOX_TIER_PRESET'];
      const { loadConfig } = await import('./config.js');
      expect(() => loadConfig()).not.toThrow();
    });

    it('picking STANDARD sticks — the pin does not silently revert it to hybrid', async () => {
      // REWRITTEN 2026-08-17. The previous version wrote `{ tier_preset: null }`
      // straight to disk and passed — but the product's writer CANNOT produce
      // that state: `PUT /api/config` deletes a null key (http-api.ts, "explicit
      // null = delete field"). So the green test proved nothing about any
      // reachable configuration; it was false confidence, the exact class this
      // file guards against elsewhere.
      //
      // This is the state the writer really leaves behind when a tenant clicks
      // Standard: `buildRoutingUpdate` sends `{routing_mode:'standard',
      // tier_preset:null}`, the null key is dropped, and `routing_mode` — not
      // null, therefore persisted — is what remains.
      writeUserConfig({ routing_mode: 'standard' });
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.routing_mode).toBe('standard');
      expect(config.tier_preset).toBeUndefined();
      expect(config.tier_set?.deep?.api_base_url).toBeUndefined();
    });

    it('a PARTIAL custom tier_set is not quietly completed out of the pin', async () => {
      // Custom sends `{routing_mode:'hybrid', tier_preset:null, tier_set}`. With
      // the seed firing, the expander's `{...expanded.tier_set, ...merged.tier_set}`
      // filled every slot the tenant left empty from the pinned preset — so a
      // tenant who set only `deep` silently got the pin's fast and balanced.
      writeUserConfig({ routing_mode: 'hybrid', tier_set: { deep: { provider: 'anthropic', model_id: 'claude-opus-5' } } });
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_set?.deep?.model_id).toBe('claude-opus-5');
      expect(config.tier_set?.fast).toBeUndefined();
      expect(config.tier_set?.balanced).toBeUndefined();
    });

    it('a hand-edited null tier_preset is still respected (defensive, not reachable)', async () => {
      // Kept as defence for a config.json edited outside the product — the
      // schema is `.nullable()`, so the value is representable even though the
      // writer never emits it. Labelled as unreachable so it is not mistaken for
      // evidence about the product's own path; the two tests above are that.
      writeUserConfig({ tier_preset: null as unknown as string });
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBeNull();
      expect(config.tier_set?.deep?.api_base_url).toBeUndefined();
    });

    it('the CP pin still applies when the tenant has chosen NOTHING', async () => {
      // The case the pin was actually built for: an instance sitting on default
      // routing while a paid-for, DPA-disclosed provider went unused. Seeding must
      // not break it — without this, "make it overridable" could quietly become
      // "make it inert", and nobody would notice until a fleet pin did nothing.
      writeUserConfig({});
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBe('efficient');
      expect(config.tier_set?.deep?.api_base_url).toContain('fireworks');
    });

    it('an unset or blank LYNOX_TIER_PRESET leaves the config.json preset alone', async () => {
      // Absence must be the pre-change path exactly — an older engine ignoring the
      // var and a newer one seeing it empty have to agree, or a rollout drifts.
      writeUserConfig({ tier_preset: 'balanced' });
      process.env['LYNOX_TIER_PRESET'] = '   ';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_set?.deep).toEqual({
        provider: 'openai',
        model_id: 'accounts/fireworks/models/kimi-k3',
        api_base_url: 'https://api.fireworks.ai/inference/v1',
      });
    });

    it('an unknown CP-pinned preset is IGNORED, not fatal — the container still boots', async () => {
      // Deliberately the reverse of what this test asserted before. It used to pin
      // the throw, arguing that a silent standard boot would make a fleet-wide
      // rollout look successful while routing nothing. That concern is real and is
      // now carried by a warn log; what the throw actually bought was worse — the
      // engine ctor's loadConfig() has no catch, so an unknown pin took the
      // container down with no way back, and the CP can emit one whenever it is
      // deployed ahead of the fleet (which is the normal direction: the CP
      // redeploys on release dispatch, the fleet rolls out by hand, and a pinned
      // instance is skipped by rollouts indefinitely).
      //
      // The asymmetry with a config.json name is the point: an unknown PIN degrades
      // to the documented meaning of an unset pin, i.e. the instance's own default
      // routing — no tier_set, no unregistered model, so none of the
      // FALLBACK_CAPABILITY misbilling the throw exists to prevent.
      process.env['LYNOX_TIER_PRESET'] = 'ultra-cheap';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBeUndefined();
      expect(config.tier_set).toBeUndefined();
      expect(config.routing_mode).not.toBe('hybrid');
    });

    it('an unknown pin does not silently swallow a VALID persisted preset', async () => {
      // Counter-direction: ignoring the pin must not also drop what the tenant
      // chose. Only the pin's own name is in question here.
      writeUserConfig({ tier_preset: 'max-quality' });
      process.env['LYNOX_TIER_PRESET'] = 'ultra-cheap';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBe('max-quality');
      expect(config.routing_mode).toBe('hybrid');
    });

    it('NEITHER name resolvable → boots on default routing instead of crash-looping', async () => {
      // REVERSED 2026-08-17 after review (rafael's call). This used to assert the
      // throw, on the reasoning that with no valid pin to rescue WITH the tenant's
      // own state is corrupt and belongs in the fail-closed path.
      //
      // The two names do not fail independently — they fail TOGETHER in exactly
      // the skew the pin guard exists for. Pin an instance to an older image (a
      // routine operation here) and BOTH the tenant's persisted name and the CP's
      // pin come from a vocabulary that engine does not carry. Throwing there is
      // the same crash-loop with the same missing exit: the settings UI that would
      // clear the value is served by the container that will not boot. Fixing the
      // pin half and leaving this one meant the rescue was weakest precisely when
      // it was needed.
      //
      // An empty preset means what it has always meant — the instance keeps its
      // own default routing. No tier_set, no unregistered model, so none of the
      // misbilling the fail-closed throw exists to prevent.
      writeUserConfig({ tier_preset: 'eu-sovereign' });
      process.env['LYNOX_TIER_PRESET'] = 'ultra-cheap';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBeUndefined();
      expect(config.routing_mode).not.toBe('hybrid');
      expect(config.tier_set).toBeUndefined();
    });

    it('a VALID pin still rescues rather than clearing — the rescue is not a blanket drop', async () => {
      // Counter-direction for the clear above: it must fire only when there is
      // nothing to rescue with. Without this, "always clear the persisted name"
      // would satisfy the previous test and silently disable the rescue path.
      writeUserConfig({ tier_preset: 'eu-sovereign' });
      process.env['LYNOX_TIER_PRESET'] = 'efficient';
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBe('efficient');
      expect(config.routing_mode).toBe('hybrid');
    });

    it('warns about an ignored pin even when a tenant preset wins', async () => {
      // The warn used to sit inside the seed branch, which a tenant-chosen preset
      // skips. During a fleet-wide bad pin that meant the log lines appeared only
      // on the subset that would have adopted it — so an operator could not even
      // count the affected instances from stdout.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        writeUserConfig({ tier_preset: 'max-quality' });
        process.env['LYNOX_TIER_PRESET'] = 'ultra-cheap';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().tier_preset).toBe('max-quality');
        expect(warn.mock.calls.flat().join(' ')).toContain('ultra-cheap');
      } finally {
        warn.mockRestore();
      }
    });

    it('warns when a preset RESOLVES but none of its slots can be backed', async () => {
      // The expensive case, and the one the ignore-warning cannot cover: the name
      // is valid, so nothing above fires, while every band silently moves to the
      // base model. Left unsaid, this is invisible until the invoice.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        process.env['LYNOX_BILLING_TIER'] = 'managed';
        process.env['ANTHROPIC_API_KEY'] = 'cp-key';
        process.env['LYNOX_TIER_PRESET'] = 'efficient';
        delete process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'];
        delete process.env['FIREWORKS_API_KEY'];
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().tier_preset).toBeUndefined();
        expect(warn.mock.calls.flat().join(' ')).toContain('none of its slots could be backed');
      } finally {
        warn.mockRestore();
      }
    });

    it('does NOT warn when a preset resolves AND its slots are backed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        process.env['LYNOX_BILLING_TIER'] = 'managed';
        process.env['ANTHROPIC_API_KEY'] = 'cp-key';
        process.env['LYNOX_MANAGED_FIREWORKS_ENABLED'] = '1';
        process.env['FIREWORKS_API_KEY'] = 'fw-key';
        process.env['LYNOX_TIER_PRESET'] = 'efficient';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().tier_preset).toBe('efficient');
        expect(warn.mock.calls.flat().join(' ')).not.toContain('could be backed');
      } finally {
        warn.mockRestore();
      }
    });

    it('escapes AND bounds the pin name it prints — both, and by code point', async () => {
      // Two properties, both previously unpinned. The LENGTH bound survived being
      // deleted (the old fixture was 27 characters), and the character handling
      // stripped rather than escaped — which renamed an unresolvable pin into a
      // valid one in the very line that calls it unknown.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        // U+2028 is a JS line terminator: the forged-log-line threat the bound was
        // justified by, and exactly what a C0-only class lets through.
        process.env['LYNOX_TIER_PRESET'] = 'bad\u2028[lynox] FATAL: fake\u0001' + 'x'.repeat(200);
        const { loadConfig } = await import('./config.js');
        loadConfig();
        const printed = warn.mock.calls.flat().join(' ');
        expect(printed).toContain('bad\\u2028[lynox] FATAL: fake\\u0001');
        expect(printed).not.toMatch(/[\u0000-\u001F\u0085\u007F\u2028\u2029]/);
        const shown = /LYNOX_TIER_PRESET="([^"]*)"/.exec(printed)?.[1] ?? '';
        expect(shown.length).toBeLessThanOrEqual(64);
      } finally {
        warn.mockRestore();
      }
    });

    it('does NOT warn when the pin resolves', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        process.env['LYNOX_TIER_PRESET'] = 'efficient';
        const { loadConfig } = await import('./config.js');
        loadConfig();
        expect(warn.mock.calls.flat().join(' ')).not.toContain('LYNOX_TIER_PRESET');
      } finally {
        warn.mockRestore();
      }
    });

    it('an unknown tier_preset name is dropped with a warning, not fatal', async () => {
      // The sibling of the reversal above, same reasoning: an unknown NAME has no
      // misbill to guard against, so failing closed only costs the boot. The
      // fail-closed throw that DOES guard money — a preset that resolves but names
      // an unregistered model — is the test below, and it is untouched.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        writeUserConfig({ tier_preset: 'ultra-cheap' });
        const { loadConfig } = await import('./config.js');
        const config = loadConfig();
        expect(config.tier_preset).toBeUndefined();
        expect(warn.mock.calls.flat().join(' ')).toContain('ultra-cheap');
      } finally {
        warn.mockRestore();
      }
    });

    it('a preset referencing an UNREGISTERED model FAILS CLOSED (no Opus-rate FALLBACK misbill)', async () => {
      const bad = { routing_mode: 'hybrid', tier_set: { deep: { provider: 'openai', model_id: 'ghost-model-not-registered' } } };
      vi.doMock('./tier-presets.js', () => ({
        TIER_PRESETS: { bad },
        expandTierPreset: (name: string) => (name === 'bad' ? bad : undefined),
      }));
      writeUserConfig({ tier_preset: 'bad' });
      const { loadConfig } = await import('./config.js');
      expect(() => loadConfig()).toThrow(/unregistered model "ghost-model-not-registered"/);
      vi.doUnmock('./tier-presets.js');
    });

    it('a config.json tier_set slot overrides the preset per-slot (preset < config)', async () => {
      writeUserConfig({
        tier_preset: 'balanced',
        tier_set: { deep: { provider: 'anthropic', model_id: 'claude-opus-4-8' } },
      });
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_set?.deep?.model_id).toBe('claude-opus-4-8'); // config override won over the preset's sonnet-5
      expect(config.tier_set?.balanced?.model_id).toBe('accounts/fireworks/models/glm-5p2'); // preset slot kept
    });

    it('a config tier_set override with an UNREGISTERED model FAILS CLOSED (post-merge guard)', async () => {
      writeUserConfig({
        tier_preset: 'balanced',
        tier_set: { deep: { provider: 'openai', model_id: 'ghost-override-model' } },
      });
      const { loadConfig } = await import('./config.js');
      expect(() => loadConfig()).toThrow(/unregistered model "ghost-override-model"/);
    });

    it('expands the ⚡ efficient preset (all-Fireworks slots) end-to-end', async () => {
      // Reshaped 2026-08-10: every slot is an open-weight model on Fireworks with a
      // 1M window, so the expansion has to carry the endpoint on all three, not just
      // on deep as it did when fast/main were Mistral.
      writeUserConfig({ tier_preset: 'efficient' });
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_set?.deep).toEqual({
        provider: 'openai',
        model_id: 'accounts/fireworks/models/kimi-k3',
        api_base_url: 'https://api.fireworks.ai/inference/v1',
      });
      expect(config.tier_set?.balanced?.model_id).toBe('accounts/fireworks/models/minimax-m3');
      expect(config.tier_set?.fast?.model_id).toBe('accounts/fireworks/models/deepseek-v4-flash-0731');
      for (const tier of ['fast', 'balanced', 'deep'] as const) {
        expect(config.tier_set?.[tier]?.api_base_url).toBe('https://api.fireworks.ai/inference/v1');
      }
    });

    it('tier_preset in a PROJECT config is IGNORED (not in PROJECT_SAFE_KEYS — no escalation)', async () => {
      const projectDir = join(fakeProject, '.lynox');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'config.json'), JSON.stringify({ tier_preset: 'balanced' }));
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.tier_preset).toBeUndefined();
      expect(config.routing_mode).not.toBe('hybrid');
    });
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

  // Main-chat model picker (Slice 1): default_tier is env-as-SEED, not a lock —
  // a persisted file value (the user's picker choice) wins over the CP env.
  it('default_tier: a file value WINS over the LYNOX_DEFAULT_MODEL_TIER env (seed, not override)', async () => {
    const userDir = join(fakeHome, '.lynox');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ default_tier: 'deep' }));

    process.env['LYNOX_DEFAULT_MODEL_TIER'] = 'balanced'; // CP-emitted seed
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.default_tier).toBe('deep'); // the user's picker choice wins
  });

  it('default_tier: the env SEEDS the value when the file has none', async () => {
    process.env['LYNOX_DEFAULT_MODEL_TIER'] = 'balanced';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.default_tier).toBe('balanced'); // seed applies on a fresh instance
  });

  it('max_tier STILL env-wins over a file value (the ceiling is a lock, not a seed)', async () => {
    const userDir = join(fakeHome, '.lynox');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'config.json'), JSON.stringify({ max_tier: 'deep' }));

    process.env['LYNOX_MAX_MODEL_TIER'] = 'balanced'; // CP cost ceiling — must win
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.max_tier).toBe('balanced'); // env-wins asymmetry vs default_tier
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

  it('tolerates retired verb_graph_* keys in config.json (not nulled by .strict())', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    // A mid-rollout tenant's config.json may still carry the S3f-retired verb-layer
    // rollout flags. They must be tolerated-and-ignored, NOT reject the WHOLE config
    // under .strict() (which would silently drop default_tier + every other setting).
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      default_tier: 'balanced',
      verb_graph_enabled: true,
      verb_graph_reads: false,
    }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.default_tier).toBe('balanced'); // survived → config was not nulled
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

  it('keeps memory_graph_reads from config.json (S5b — not stripped by .strict())', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      default_tier: 'balanced',
      subject_graph_enabled: true,
      memory_graph_reads: true,
    }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.memory_graph_reads).toBe(true);
    expect(config.default_tier).toBe('balanced'); // config not nulled
  });

  it('reads memory_graph_reads from env explicitly (true/1 vs false/0, no coerce)', async () => {
    for (const truthy of ['true', '1']) {
      vi.resetModules();
      process.env['LYNOX_MEMORY_GRAPH_READS'] = truthy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().memory_graph_reads).toBe(true);
    }
    for (const falsy of ['false', '0']) {
      vi.resetModules();
      process.env['LYNOX_MEMORY_GRAPH_READS'] = falsy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().memory_graph_reads).toBe(false);
    }
    // a non-enum value is ignored (never coerced to true)
    vi.resetModules();
    process.env['LYNOX_MEMORY_GRAPH_READS'] = 'yes';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().memory_graph_reads).toBeUndefined();
  });

  it('keeps memory_scoring_v2 + retrieval_shadow_log from config.json (Wave 0 — not stripped by .strict())', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      default_tier: 'balanced',
      memory_scoring_v2: true,
      retrieval_shadow_log: true,
    }));

    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.memory_scoring_v2).toBe(true);
    expect(config.retrieval_shadow_log).toBe(true);
    expect(config.default_tier).toBe('balanced'); // config not nulled by an unknown key
  });

  it('reads memory_scoring_v2 from env explicitly (true/1 vs false/0, no coerce)', async () => {
    for (const truthy of ['true', '1']) {
      vi.resetModules();
      process.env['LYNOX_MEMORY_SCORING_V2'] = truthy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().memory_scoring_v2).toBe(true);
    }
    for (const falsy of ['false', '0']) {
      vi.resetModules();
      process.env['LYNOX_MEMORY_SCORING_V2'] = falsy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().memory_scoring_v2).toBe(false);
    }
    vi.resetModules();
    process.env['LYNOX_MEMORY_SCORING_V2'] = 'yes';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().memory_scoring_v2).toBeUndefined(); // non-enum ignored, never coerced
  });

  it('reads debug_wire_capture from env explicitly (true/1 vs false/0, no coerce)', async () => {
    for (const truthy of ['true', '1']) {
      vi.resetModules();
      process.env['LYNOX_DEBUG_WIRE_CAPTURE'] = truthy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().debug_wire_capture).toBe(true);
    }
    for (const falsy of ['false', '0']) {
      vi.resetModules();
      process.env['LYNOX_DEBUG_WIRE_CAPTURE'] = falsy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().debug_wire_capture).toBe(false);
    }
    // a non-enum value is ignored (never coerced to true — an errant env must not
    // silently enable content capture for a tenant)
    vi.resetModules();
    process.env['LYNOX_DEBUG_WIRE_CAPTURE'] = 'yes';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().debug_wire_capture).toBeUndefined();
  });

  it('keeps debug_wire_capture from config.json (not stripped by .strict())', async () => {
    const dir = join(fakeHome, '.lynox');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      default_tier: 'balanced',
      debug_wire_capture: true,
    }));
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect(config.debug_wire_capture).toBe(true);
    expect(config.default_tier).toBe('balanced'); // config not nulled by the new key
  });

  it('reads retrieval_shadow_log from env explicitly (true/1 vs false/0, no coerce)', async () => {
    for (const truthy of ['true', '1']) {
      vi.resetModules();
      process.env['LYNOX_RETRIEVAL_SHADOW_LOG'] = truthy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().retrieval_shadow_log).toBe(true);
    }
    for (const falsy of ['false', '0']) {
      vi.resetModules();
      process.env['LYNOX_RETRIEVAL_SHADOW_LOG'] = falsy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().retrieval_shadow_log).toBe(false);
    }
    vi.resetModules();
    process.env['LYNOX_RETRIEVAL_SHADOW_LOG'] = 'on';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().retrieval_shadow_log).toBeUndefined();
  });

  it('reads memory_write_trust_gate from env explicitly (true/1 vs false/0, no coerce)', async () => {
    for (const truthy of ['true', '1']) {
      vi.resetModules();
      process.env['LYNOX_MEMORY_WRITE_TRUST_GATE'] = truthy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().memory_write_trust_gate).toBe(true);
    }
    for (const falsy of ['false', '0']) {
      vi.resetModules();
      process.env['LYNOX_MEMORY_WRITE_TRUST_GATE'] = falsy;
      const { loadConfig } = await import('./config.js');
      expect(loadConfig().memory_write_trust_gate).toBe(false);
    }
    vi.resetModules();
    process.env['LYNOX_MEMORY_WRITE_TRUST_GATE'] = 'yes';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().memory_write_trust_gate).toBeUndefined(); // non-enum ignored, never coerced
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

  it('accepts guarded as a LYNOX_NETWORK_POLICY value', async () => {
    process.env['LYNOX_NETWORK_POLICY'] = 'guarded';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().network_policy).toBe('guarded');
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

  it('LYNOX_COMPACTION_MODEL sets compaction_model (canonical + legacy brand value)', async () => {
    process.env['LYNOX_COMPACTION_MODEL'] = 'fast';
    const canonical = (await import('./config.js')).loadConfig();
    expect(canonical.compaction_model).toBe('fast');

    vi.resetModules();
    delete process.env['LYNOX_COMPACTION_MODEL'];
    process.env['LYNOX_COMPACTION_MODEL'] = 'haiku'; // legacy brand value, normalized to fast
    const legacy = (await import('./config.js')).loadConfig();
    expect(legacy.compaction_model).toBe('fast');
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

  // `api_key` is the LEGACY field that pre-vault callers (spawn, pipeline,
  // plan-task, process, the orchestrator) pair DIRECTLY with `api_base_url`. It is
  // filled unconditionally from ANTHROPIC_API_KEY — the documented Docker env var —
  // which is right for the Anthropic wire and wrong for every other one. The old
  // code special-cased exactly ONE endpoint (Mistral) and left every other
  // OpenAI-compatible one holding the Anthropic key: select Groq, and the Anthropic
  // key goes to Groq as a bearer token; select a local runtime, and it goes to
  // localhost in plaintext over http.
  it('does NOT leave the Anthropic key on a Groq endpoint', async () => {
    writeUserConfig({ provider: 'openai', api_base_url: 'https://api.groq.com/openai/v1' });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-should-never-reach-groq';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBeUndefined();
  });

  it('does NOT leave the Anthropic key on a local Ollama endpoint', async () => {
    writeUserConfig({ provider: 'openai', api_base_url: 'http://localhost:11434/v1' });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-should-never-reach-localhost';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBeUndefined();
  });

  it('does NOT leave the Anthropic key on a GENERIC openai endpoint (no preset)', async () => {
    // The most common non-preset config: an OpenRouter / DeepSeek / bare-proxy URL
    // that falls through to the generic openai-compat tile. It has no pinned slot,
    // so an earlier narrowing to "pinned endpoints only" left the inherited
    // Anthropic key sitting on it — while the vault path stripped it. The two must
    // strip for the same set of endpoints.
    writeUserConfig({ provider: 'openai', api_base_url: 'https://openrouter.ai/api/v1' });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-should-never-reach-openrouter';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBeUndefined();
  });

  it('uses the endpoint’s OWN key when it has one', async () => {
    writeUserConfig({ provider: 'openai', api_base_url: 'https://api.groq.com/openai/v1' });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-xxx';
    process.env['GROQ_API_KEY'] = 'sk-groq-own';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBe('sk-groq-own');
  });

  it('keeps a config.json key on a pinned endpoint with no env key of its own', async () => {
    // The user wrote this key themselves, for this endpoint. The inherited
    // Anthropic env var must not displace it — and clearing it would be just as
    // wrong, since it is the only key that actually belongs here.
    writeUserConfig({ provider: 'openai', api_base_url: 'https://api.groq.com/openai/v1', api_key: 'sk-mine' });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-xxx';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBe('sk-mine');
  });

  it('leaves the Anthropic wire untouched (byte-parity for the default install)', async () => {
    writeUserConfig({ provider: 'anthropic' });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-xxx';
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBe('sk-ant-xxx');
  });

  // The guard shared by BOTH assignment paths — the env one here and the vault
  // one in engine-init.ts. Keeping them on one predicate is the point: the leak
  // survived three review rounds because each path was patched separately.
  it('anthropicKeyMayHoldApiKey: blocks only the openai wire', async () => {
    const { anthropicKeyMayHoldApiKey } = await import('./config.js');
    expect(anthropicKeyMayHoldApiKey('openai')).toBe(false);   // Mistral/Groq/Ollama — leak
    expect(anthropicKeyMayHoldApiKey('anthropic')).toBe(true);
    expect(anthropicKeyMayHoldApiKey('custom')).toBe(true);    // Anthropic-wire proxy — legit
    expect(anthropicKeyMayHoldApiKey('vertex')).toBe(true);    // ignores api_key anyway
    expect(anthropicKeyMayHoldApiKey(undefined)).toBe(true);   // legacy default
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
