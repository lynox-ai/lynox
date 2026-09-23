import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { apiSetupTool } from './api-setup.js';
import { ApiStore, type ApiProfile } from '../../core/api-store.js';

let mockLynoxDir: string;
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => mockLynoxDir }));

// The register ships empty on purpose, so every test that needs a provider
// hands in its own — through the same parameter production never passes.
vi.mock('../../core/oauth-presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/oauth-presets.js')>();
  const register = real.presetRegisterOf([{
    id: 'example-shop',
    label: 'Example Shop',
    host: { kind: 'template', param: 'shop', template: '{shop}.shops.example.com' },
    authorizePath: '/admin/oauth/authorize',
    tokenPath: '/admin/oauth/access_token',
    params: [{ name: 'shop', pattern: /[a-z0-9][a-z0-9-]{0,59}/, describe: 'the shop name' }],
  }, {
    // A provider whose host is inside the operator's own network. Nothing would
    // stop a preset from being written this way, and the egress vetting says yes
    // to it — so the one place that can say no is the redirect guard.
    id: 'lan-shop',
    label: 'LAN Shop',
    host: { kind: 'constant', host: '127.0.0.1' },
    authorizePath: '/admin/oauth/authorize',
    tokenPath: '/admin/oauth/access_token',
    params: [],
  }, {
    // A provider whose host is on the VETTED list. It exists to isolate the
    // redirect consent: nothing about this profile is a non-vetted egress, so
    // if a prompt appears at save time it appeared for the other reason.
    id: 'vetted-shop',
    label: 'Vetted Shop',
    host: { kind: 'constant', host: 'api.openai.com' },
    authorizePath: '/admin/oauth/authorize',
    tokenPath: '/admin/oauth/access_token',
    params: [],
  }, {
    // Written wrongly on purpose: no leading slash, so the path would merge
    // into the authority. The operator cannot fix this one.
    id: 'broken-path',
    label: 'Broken Path',
    host: { kind: 'constant', host: 'shops.example.com' },
    authorizePath: 'admin/oauth/authorize',
    tokenPath: '/admin/oauth/access_token',
    params: [],
  }]);
  return {
    ...real,
    derivePresetEndpoints: (id: string, params: Readonly<Record<string, unknown>> | undefined) =>
      real.derivePresetEndpoints(id, params, register),
    presetIds: () => register.ids(),
  };
});

const tmpDirs: string[] = [];
let originBefore: string | undefined;

beforeEach(() => {
  mockLynoxDir = mkdtempSync(join(tmpdir(), 'lynox-connect-test-'));
  tmpDirs.push(mockLynoxDir);
  originBefore = process.env['ORIGIN'];
  process.env['ORIGIN'] = 'https://tenant.lynox.example';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originBefore === undefined) delete process.env['ORIGIN'];
  else process.env['ORIGIN'] = originBefore;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function shopProfile(over: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'shop-api',
    name: 'Shop',
    base_url: 'https://acme.shops.example.com/admin',
    description: 'Shop API',
    auth: {
      type: 'oauth2',
      vault_keys: ['SHOP_CLIENT_ID', 'SHOP_CLIENT_SECRET'],
      oauth: {
        grant_type: 'refresh_token',
        client_id_key: 'SHOP_CLIENT_ID',
        client_secret_key: 'SHOP_CLIENT_SECRET',
        preset_id: 'example-shop',
        preset_params: { shop: 'acme' },
      },
    },
    // A profile that passed the save gate carries the acceptance of the host it
    // authorizes at — the disclosure above that prompt is what puts it there.
    // Without it here every reply below would be the un-acked refusal, which is
    // a case of its own further down rather than the backdrop of all of them.
    custom_endpoint_ack: {
      accepted: true,
      hosts: ['acme.shops.example.com'],
      // The second half, and it is a separate field because it records a
      // separate act: being sent there in a browser, rather than the engine
      // sending data there. A profile with only the first is a real shape and
      // has its own case below.
      redirect_hosts: ['acme.shops.example.com'],
      accepted_at: '2026-09-22T00:00:00.000Z',
    },
    ...over,
  };
}

// Sentinels, not 'id' and 'secret': an assertion that the reply carries no
// secret cannot tell the VALUE `'secret'` from the word `secret` in
// `SHOP_CLIENT_SECRET`, and `'id'` is a substring of half the English language.
// Spelled out rather than random-looking, because the first pair read as a
// credential to the secret scanner — a fixture that has to look fake to a guard
// and stay distinct to an assertion is both here.
const CLIENT_ID_VALUE = 'not-a-real-client-id-only-a-fixture';
const CLIENT_SECRET_VALUE = 'not-a-real-client-secret-only-a-fixture';

function agentWith(store: ApiStore, secrets: Record<string, string> = { SHOP_CLIENT_ID: CLIENT_ID_VALUE, SHOP_CLIENT_SECRET: CLIENT_SECRET_VALUE }): never {
  return {
    sessionCounters: { httpRequests: 0, approvedOutboundDomains: new Set<string>(), pendingOutboundPrompts: new Map<string, unknown>() },
    secretStore: {
      resolveSecretRefs: (input: unknown): unknown => {
        const text = JSON.stringify(input);
        return JSON.parse(text.replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (m, name: string) => secrets[name] ?? m)) as unknown;
      },
    },
    toolContext: { apiStore: store, dataStore: null, taskManager: null, knowledgeLayer: null, runHistory: null, userConfig: {}, tools: [], streamHandler: null, networkPolicy: undefined, allowedHosts: undefined, allowedWildcards: [], rateLimitProvider: null, hourlyRateLimit: Infinity, dailyRateLimit: Infinity, isolationEnvOverride: undefined, isolationMinimalEnv: false },
  } as never;
}

const connect = (agent: never, id = 'shop-api'): Promise<string> =>
  apiSetupTool.handler({ action: 'connect', id }, agent) as Promise<string>;

describe('a preset profile discloses the host it will authorize at', () => {
  it('puts the derived authorize host into the save-time egress question', async () => {
    // Without this the connect route asks for an acceptance of a host the save
    // never offered, and its advice — save it again and accept — cannot be
    // followed. The profile calls one host and authorizes at another, so the
    // fixture separates them: an ack that covers only base_url is not enough.
    const store = new ApiStore();
    const asked: string[] = [];
    const agent = agentWith(store);
    // The prompt is a tagged template, so what arrives is a structure, not a
    // string — stringify it rather than assume, or the assertion reads
    // '[object Object]' and passes for the wrong reason.
    (agent as unknown as { promptUser: (q: unknown) => Promise<string> }).promptUser = async (q: unknown) => {
      asked.push(typeof q === 'string' ? q : JSON.stringify(q));
      return 'no';
    };

    await apiSetupTool.handler({ action: 'create', profile: {
      ...shopProfile(), base_url: 'https://api.acme-cdn.example/v1', custom_endpoint_ack: undefined,
      endpoints: [{ method: 'GET', path: '/x', description: 'x' }], guidelines: ['x'], avoid: ['x'],
    } }, agent);

    expect(asked.join(' ')).toContain('acme.shops.example.com');
  });
});

describe('the preset fields are checked at the door, not at the derivation', () => {
  // The same argument the username/password keys in this validator already
  // carry: these values come from the profile, a prompt-injected agent can
  // author them, and the door is where the operator is still present. The
  // derivation refuses a non-string later and that refusal is the real
  // boundary — what this adds is that a structurally broken profile does not
  // persist to fail somewhere nobody is watching.
  const createWith = (oauth: Record<string, unknown>): Promise<string> =>
    apiSetupTool.handler({ action: 'create', profile: {
      ...shopProfile(),
      auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID'], oauth },
      endpoints: [{ method: 'GET', path: '/x', description: 'x' }], guidelines: ['x'], avoid: ['x'],
    } }, agentWith(new ApiStore())) as Promise<string>;

  it.each([
    ['a preset id that is not one', { preset_id: 'Example Shop' }, 'auth.oauth.preset_id'],
    ['parameters that are not name/value pairs', { preset_id: 'example-shop', preset_params: ['acme'] }, 'auth.oauth.preset_params'],
    ['a parameter that is not text', { preset_id: 'example-shop', preset_params: { shop: 7 } }, 'auth.oauth.preset_params.shop'],
    // In production a vault reference to an ordinary secret is substituted
    // before this handler runs — which is the danger: the VALUE would become a
    // DNS label in an address the engine hands a browser. What still arrives
    // literally is an infrastructure secret, which the resolver deliberately
    // leaves alone, and an unresolvable name. Those are what this can refuse,
    // and the refusal teaches the rule for all of them.
    ['a vault reference as a parameter', { preset_id: 'example-shop', preset_params: { shop: 'secret:LYNOX_ADMIN_TOKEN' } }, 'auth.oauth.preset_params.shop'],
    // This row is load-bearing beyond its own assertion: the grammar is the ONLY
    // thing refusing a vault reference here — a separate reference check was
    // written and deleted after a mutation showed it could never fire, because
    // a reference needs a colon and an uppercase letter and the grammar allows
    // neither. Loosen the grammar and this goes red, which is the point.
    ['a vault reference as the provider id', { preset_id: 'secret:LYNOX_ADMIN_TOKEN' }, 'auth.oauth.preset_id'],
  ])('refuses %s', async (_label, oauth, field) => {
    const result = await createWith(oauth);

    expect(result).toContain('Validation error');
    expect(result).toContain(field);
  });

  it.each([
    ['a value that fails the grammar', 'Example Shop'],
    ['a vault reference', 'secret:LYNOX_ADMIN_TOKEN'],
  ])('names the field and never the value when preset_id carries %s', async (_label, presetId) => {
    // The asymmetry that gave this away: the two `preset_params` refusals name
    // the field and never the value, and `preset_id` did the opposite — twice.
    // Tool input passes through the secret resolver before this handler runs,
    // and the consent that resolver asks for is per-NAME and remembered, so a
    // name accepted once for an unrelated call is substituted here with no
    // prompt at all. A refusal that quotes what arrived puts the resolved value
    // into the model's context.
    const result = await createWith({ preset_id: presetId });

    expect(result).toContain('Validation error');
    expect(result).toContain('auth.oauth.preset_id');
    expect(result).not.toContain(presetId);
  });

  it('lets a well-formed pair through, so the refusals above are about shape and not about presence', async () => {
    // The control. Without it every assertion above would still pass if the
    // validator simply refused all preset profiles.
    const result = await createWith({ preset_id: 'example-shop', preset_params: { shop: 'acme' }, client_id_key: 'SHOP_CLIENT_ID' });

    expect(result).not.toContain('Validation error');
  });
});

describe('a save that cannot derive the authorize host says so', () => {
  // The silent version made the completeness of a human-facing security
  // disclosure depend on whether an unrelated parameter happened to validate,
  // with no trace in either direction. Refusing the save was the other
  // candidate and is worse: a provider retired from the register would make
  // every profile naming it unsaveable, including the update removing the field.
  const saveWith = async (oauth: Record<string, unknown>, over: Partial<ApiProfile> = {}, prompt?: (q: unknown) => Promise<string>): Promise<string> => {
    const agent = agentWith(new ApiStore());
    if (prompt) (agent as unknown as { promptUser: (q: unknown) => Promise<string> }).promptUser = prompt;
    return apiSetupTool.handler({ action: 'create', profile: {
      ...shopProfile(),
      auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID'], oauth },
      endpoints: [{ method: 'GET', path: '/x', description: 'x' }], guidelines: ['x'], avoid: ['x'],
      ...over,
    } }, agent) as Promise<string>;
  };

  it('names the provider it does not know, in the reply, with no prompt in the way', async () => {
    // A vetted base_url, so the disclosure prompt never runs — which is exactly
    // the case where the missing authorize host would otherwise leave no trace
    // anywhere at all.
    const result = await saveWith({ preset_id: 'not-a-provider' }, { base_url: 'http://shop.local/api', custom_endpoint_ack: undefined });

    expect(result).toContain('Created');
    expect(result).toContain('No authorization address could be derived');
    // And it does NOT repeat the id back. Tool input passes through the secret
    // resolver before this handler runs, so an unknown `preset_id` can be a
    // resolved vault value that merely looks like a provider name — and this
    // string goes into the model's context and into a human's prompt. The
    // engine's OWN ids are safe to print, so the message says what it knows
    // instead of what it was given.
    expect(result).not.toContain('not-a-provider');
  });

  it.each([
    ['a preset whose path would join the authority', 'broken-path'],
  ])('blames the engine, not the operator, for %s', async (_label, presetId) => {
    // A defect in a compiled preset is not a missing profile field. While both
    // arrived as the same refusal, the note read "the provider needs the
    // provider path (auth.oauth.preset_params.path), which this profile does not
    // supply. Set it with api_setup update" — a field that does not exist, about
    // something the operator cannot fix.
    const result = await saveWith({ preset_id: presetId }, { base_url: 'http://shop.local/api', custom_endpoint_ack: undefined });

    expect(result).toContain('defined wrongly in this engine');
    expect(result).not.toContain('preset_params.path');
    expect(result).not.toMatch(/Set it with api_setup update/);
  });

  it('says a refused value was refused, not that it is missing', async () => {
    // The other half of the same split: telling someone to set a value they
    // already set sends them round a loop. `ACME` fails the shop pattern.
    const result = await saveWith(
      { preset_id: 'example-shop', preset_params: { shop: 'ACME' } },
      { base_url: 'http://shop.local/api', custom_endpoint_ack: undefined },
    );

    expect(result).toContain('is not one the provider');
    expect(result).not.toContain('does not supply');
  });

  it('names the parameter it is missing, and says the host is disclosed once it is set', async () => {
    const result = await saveWith({ preset_id: 'example-shop', preset_params: {} }, { base_url: 'http://shop.local/api', custom_endpoint_ack: undefined });

    expect(result).toContain('the shop name');
    expect(result).toContain('auth.oauth.preset_params.shop');
  });

  it('puts the same sentence into the acceptance question, where one is asked', async () => {
    // The other half: when some other host IS non-vetted, the human deciding
    // about it should not be shown a picture that quietly omits a provider.
    const asked: string[] = [];
    await saveWith(
      { preset_id: 'example-shop', preset_params: {} },
      { custom_endpoint_ack: undefined },
      async (q: unknown) => { asked.push(typeof q === 'string' ? q : JSON.stringify(q)); return 'no'; },
    );

    expect(asked.join(' ')).toContain('No authorization address could be derived');
  });
});

describe('the save asks about being sent somewhere, not only about data', () => {
  // The acceptance the redirect reads used to be the data-egress one, whose text
  // says the user accepts controller responsibility for a data-processing
  // relationship. It never mentions being handed to a site to type a password.
  // A consent whose text does not describe the act is not a consent for that
  // act, so the act now has a sentence and a list of its own.
  const saveVetted = async (prompt: (q: unknown) => Promise<string>, store = new ApiStore(), withPrompt = true): Promise<{ store: ApiStore; reply: string }> => {
    const agent = agentWith(store);
    if (withPrompt) (agent as unknown as { promptUser: (q: unknown) => Promise<string> }).promptUser = prompt;
    const reply = await apiSetupTool.handler({ action: 'create', profile: {
      ...shopProfile(),
      // Vetted base_url AND a vetted authorize host: the data question has
      // nothing to ask about, so the prompt below can only be the other one.
      base_url: 'http://shop.local/api',
      custom_endpoint_ack: undefined,
      auth: { type: 'oauth2', vault_keys: ['SHOP_CLIENT_ID'], oauth: {
        client_id_key: 'SHOP_CLIENT_ID', client_secret_key: 'SHOP_CLIENT_SECRET',
        preset_id: 'vetted-shop', preset_params: {},
      } },
      endpoints: [{ method: 'GET', path: '/x', description: 'x' }], guidelines: ['x'], avoid: ['x'],
    } }, agent) as string;
    return { store, reply };
  };

  it('asks even when every host is vetted, because vetting answers the other question', async () => {
    const asked: string[] = [];
    await saveVetted(async (q: unknown) => { asked.push(typeof q === 'string' ? q : JSON.stringify(q)); return 'no'; });

    expect(asked).toHaveLength(1);
    const question = asked[0] ?? '';
    expect(question).toContain('api.openai.com');
    expect(question).toContain('browser');
    // And it says who the user signs in to, because that is the part a person
    // gets wrong: they are not signing in to this engine.
    expect(question).toContain('not to lynox');
    // And it must not assert the OTHER act. With every host vetted the egress
    // half has nothing to disclose, and its sentence followed by an empty list
    // would tell a human that data goes somewhere it does not — the same defect
    // as the one this whole round is about, pointing the other way.
    expect(question).not.toContain('outside lynox');
    expect(question).not.toContain('managed access_token');
  });

  it('stamps the two acceptances on separate lists', async () => {
    const { store } = await saveVetted(async () => 'allow');
    const ack = store.get('shop-api')?.custom_endpoint_ack;

    expect(ack?.redirect_hosts).toEqual(['api.openai.com']);
    // Nothing non-vetted here, so the data list stays empty — one act accepted,
    // not two. A single list would have recorded a consent nobody gave.
    expect(ack?.hosts).toEqual([]);
  });

  it('stores the profile without the acceptance when nobody can be asked', async () => {
    // The half that has nothing to leak at save time. Sharing one answer with
    // the egress half made a background run unable to create ANY preset OAuth
    // profile — a refusal nobody asked for. The profile is stored; what it does
    // not get is an acceptance nobody gave.
    const store = new ApiStore();
    const { reply } = await saveVetted(async () => 'allow', store, /* withPrompt */ false);

    expect(reply).toContain('Created');
    expect(reply).toContain('WITHOUT the acceptance');
    expect(store.get('shop-api')?.custom_endpoint_ack).toBeUndefined();
  });

  it('still refuses the SAVE when a credential would leave and nobody can be asked', async () => {
    // The other half keeps failing closed at save time, because a stored
    // profile with a non-vetted host is one a later request attaches a
    // credential to.
    const agent = agentWith(new ApiStore());
    const reply = await apiSetupTool.handler({ action: 'create', profile: {
      ...shopProfile(), custom_endpoint_ack: undefined,
      endpoints: [{ method: 'GET', path: '/x', description: 'x' }], guidelines: ['x'], avoid: ['x'],
    } }, agent) as string;

    expect(reply).toContain('Blocked');
    expect(reply).toContain('non-vetted sub-processor');
  });

  it('does not save the profile when the user declines being sent there', async () => {
    const { store, reply } = await saveVetted(async () => 'no');

    expect(reply).toContain('Blocked');
    expect(store.get('shop-api')).toBeUndefined();
  });
});

describe('the action list and the enum say the same thing', () => {
  // How this guard was earned: `connect` shipped in the enum and nowhere else,
  // and the only thing that noticed was a token-budget test — by arithmetic,
  // three tokens, for an entirely different reason. A model reading a schema
  // with an action it has no gloss for narrates it by guessing, and the guess
  // here is the behaviour the action was built to replace: asking the user to
  // paste a token. So the pairing gets a check of its own rather than a second
  // helping of luck.
  it('names every action of the enum in the description', () => {
    const schema = apiSetupTool.definition.input_schema as { properties: { action: { enum: string[] } } };
    const description = apiSetupTool.definition.description;
    const unexplained = schema.properties.action.enum.filter((action) => !description.includes(action));

    expect(unexplained, `action(s) in the enum that the description never mentions: ${unexplained.join(', ')}`).toEqual([]);
  });

  it('claims no action the enum does not offer', () => {
    // The other direction, because a description that promises an action the
    // schema refuses teaches a call that always fails.
    const schema = apiSetupTool.definition.input_schema as { properties: { action: { enum: string[] } } };
    const listed = [...apiSetupTool.definition.description.matchAll(/^- ([a-z_]+(?: \/ [a-z_]+)*):/gm)]
      .flatMap((m) => (m[1] ?? '').split(' / '));

    expect(listed.length).toBeGreaterThan(4);
    for (const action of listed) expect(schema.properties.action.enum).toContain(action);
  });
});

describe('api_setup connect — one answer per shape that can reach it', () => {
  it('A1 · says the engine has no public address, which is what it can actually tell', async () => {
    // Not "no web interface": ORIGIN is required on every tier and the installer
    // writes it, so its presence says nothing about a running server and its
    // absence says only that there is no address to return to.
    delete process.env['ORIGIN'];
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store));

    expect(result).toContain('no public address configured');
    expect(result).not.toContain('https://tenant.lynox.example');
  });

  it('A2 · refuses an id it does not know', async () => {
    const result = await connect(agentWith(new ApiStore()), 'nope');
    expect(result).toContain('not found');
  });

  it('A3 · refuses a profile that carries a static credential', async () => {
    const store = new ApiStore();
    store.register({ ...shopProfile(), auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'] } });

    const result = await connect(agentWith(store));

    expect(result).toContain('not "oauth2"');
    expect(result).toContain('does not need it');
  });

  it('A4 · refuses a profile that names no built-in provider, and says what exists', async () => {
    const store = new ApiStore();
    const base = shopProfile();
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, preset_id: 'not-a-provider' } } });

    const result = await connect(agentWith(store));

    expect(result).toContain('names no built-in provider');
    expect(result).toContain('example-shop');
    expect(result).not.toContain('https://tenant.lynox.example/api/oauth/connect');
  });

  it('A4b · names the missing parameter rather than building half a host', async () => {
    const store = new ApiStore();
    const base = shopProfile();
    store.register({ ...base, auth: { ...base.auth!, oauth: { ...base.auth!.oauth!, preset_params: {} } } });

    const result = await connect(agentWith(store));

    expect(result).toContain('the shop name');
    expect(result).toContain('preset_params.shop');
  });

  it('A5 · sends the model to ask_secret when the client credentials are missing', async () => {
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store, { SHOP_CLIENT_ID: CLIENT_ID_VALUE }));

    expect(result).toContain('ask_secret');
    expect(result).toContain('SHOP_CLIENT_SECRET');
    expect(result).not.toContain('/api/oauth/connect/');
  });

  it('A6 · says a second authorization replaces the stored token', async () => {
    const store = new ApiStore();
    store.register(shopProfile({ oauth_grant: { origin: 'callback', state: 'connected' } }));

    const result = await connect(agentWith(store));

    expect(result).toContain('already connected');
    expect(result).toContain('replaces the stored token');
    expect(result).toContain('https://tenant.lynox.example/api/oauth/connect/shop-api');
  });

  it('A6b · says nothing about a replacement for a state no callback produced', async () => {
    // The `origin === 'callback'` half of that branch was a free mutation
    // survivor: every fixture that carried `state: 'connected'` carried the
    // origin too, so dropping the check changed nothing. A record can hold a
    // state without a callback ever having run — a hand-configured profile whose
    // exchange succeeded — and that profile has no stored authorization a second
    // one would replace.
    const store = new ApiStore();
    store.register(shopProfile({ oauth_grant: { state: 'connected' } }));

    const result = await connect(agentWith(store));

    expect(result).not.toContain('already connected');
    expect(result).toContain('https://tenant.lynox.example/api/oauth/connect/shop-api');
  });

  it('A6c · treats a dead refresh as a first connect, not as a replacement', async () => {
    // The third state nothing pinned. `refresh-dead` means the stored grant no
    // longer works, so there is nothing to warn about replacing — but saying so
    // out loud is what makes it a decision rather than a fall-through.
    const store = new ApiStore();
    store.register(shopProfile({ oauth_grant: { origin: 'callback', state: 'refresh-dead' } }));

    const result = await connect(agentWith(store));

    expect(result).not.toContain('already connected');
    expect(result).toContain('It opens acme.shops.example.com');
  });

  it('A7 · says the old access is gone when the provider ended it', async () => {
    const store = new ApiStore();
    store.register(shopProfile({ oauth_grant: { state: 'revoked', revoked_fp: '0123456789abcdef' } }));

    const result = await connect(agentWith(store));

    expect(result).toContain('ended this authorization');
    expect(result).toContain('https://tenant.lynox.example/api/oauth/connect/shop-api');
  });

  it('A8 · hands out the link, names the provider host, and forbids the two wrong turns', async () => {
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store));

    expect(result).toContain('https://tenant.lynox.example/api/oauth/connect/shop-api');
    expect(result).toContain('acme.shops.example.com');
    // The two things a model does when left to itself: ask for a pasted token,
    // or assemble the link. Both are said in the reply, because the reply is
    // the only place it reads.
    expect(result).toContain('do not ask them to paste a token');
    expect(result).toContain('do not build this link yourself');
  });

  it('builds one link, whether or not the origin carries a trailing slash', async () => {
    process.env['ORIGIN'] = 'https://tenant.lynox.example/';
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store));

    expect(result).toContain('https://tenant.lynox.example/api/oauth/connect/shop-api');
    expect(result).not.toContain('example.com//api');
    expect(result).not.toContain('example//api');
  });

  it('A9 · refuses to hand out a link the route would refuse, and says why', async () => {
    // The gap this closes: `connect` used to check the preset, the derivation
    // and the vault, then hand out a link — without asking the question the
    // start route asks. On an un-accepted host the model was told to show it and
    // the user arrived at a 403. One function answers for both now.
    const store = new ApiStore();
    store.register(shopProfile({ custom_endpoint_ack: undefined }));

    const result = await connect(agentWith(store));

    expect(result).toContain('acme.shops.example.com');
    expect(result).toContain('api_setup update');
    expect(result).not.toContain('/api/oauth/connect/');
  });

  it('A2b · says a broken provider is the engine\'s fault, and does not crash saying it', async () => {
    // This arm is the only thing between a preset written wrongly and an
    // uncaught TypeError: the refusal below it reads `endpoints.param.describe`,
    // and a preset defect carries no `param`. Deleting the arm made `connect`
    // throw rather than answer — and the whole suite stayed green, because
    // nothing drove `connect` with a broken preset.
    const store = new ApiStore();
    const p = shopProfile();
    store.register({ ...p, auth: { ...p.auth!, oauth: { ...p.auth!.oauth!, preset_id: 'broken-path', preset_params: {} } } });

    const result = await connect(agentWith(store));

    expect(result).toContain('defined wrongly in this engine');
    expect(result).not.toContain('preset_params.');
    expect(result).not.toContain('/api/oauth/connect/');
  });

  it('A9b · will not read a data-egress acceptance as agreement to be sent somewhere', async () => {
    // A real acceptance, covering exactly this host, given by a human — for the
    // other act. The engine may send data there; nobody said the user agreed to
    // be handed to it and asked for a password.
    const store = new ApiStore();
    store.register(shopProfile({
      custom_endpoint_ack: { accepted: true, hosts: ['acme.shops.example.com'], accepted_at: '2026-09-22T00:00:00.000Z' },
    }));

    const result = await connect(agentWith(store));

    expect(result).toContain('sent to acme.shops.example.com');
    expect(result).not.toContain('/api/oauth/connect/');
  });

  it('A10 · refuses a provider inside the operator network without offering an acceptance', async () => {
    // The other half of the same question, and the half with no way out: a
    // private host is vouched for by the egress vetting, so it never reaches the
    // prompt that would stamp an acceptance. Advice to go and accept it would be
    // advice that cannot be followed.
    const store = new ApiStore();
    const p = shopProfile();
    store.register({ ...p, auth: { ...p.auth!, oauth: { ...p.auth!.oauth!, preset_id: 'lan-shop', preset_params: {} } } });

    const result = await connect(agentWith(store));

    expect(result).toContain('127.0.0.1');
    expect(result).toContain('inside this engine');
    expect(result).not.toContain('/api/oauth/connect/');
    expect(result).not.toMatch(/save the profile again/i);
  });

  it.each([
    // Not `lynox.example.com`: the refusal's own example address is
    // `https://lynox.example.com`, so a fixture spelled that way fails the
    // no-echo assertion against the sentence that was written to be safe. The
    // fixture is the suspect there, not the message.
    ['not an address at all', 'tenant.lynox.example'],
    ['plain http on a public host', 'http://lynox.example.com'],
    ['a username and password in the address', 'https://someone:not-a-real-password-only-a-fixture@tenant.lynox.example'],
    ['a query string', 'https://tenant.lynox.example/?x=1'],
    ['a fragment', 'https://tenant.lynox.example/#x'],
  ])('refuses an ORIGIN carrying %s, without echoing it', async (_label, origin) => {
    // The asymmetry this removes: the provider host is parsed, compared for
    // identity and checked for userinfo, while the host the user is sent to
    // FIRST had a presence test and one stripped trailing slash.
    process.env['ORIGIN'] = origin;
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store));

    expect(result).toContain('ORIGIN');
    expect(result).not.toContain('/api/oauth/connect/');
    // A misconfigured ORIGIN can hold anything somebody pasted, including a
    // credential, and this string lands in the model's context.
    expect(result).not.toContain(origin);
  });

  it('accepts plain http for an on-premise NAME, which is what its own message promises', async () => {
    // The message says "inside the operator's own network" while the check knew
    // only loopback and numeric private ranges — so an ordinary self-hosted
    // address was refused by a sentence saying it was allowed. One predicate
    // now answers the phrase in both places.
    process.env['ORIGIN'] = 'http://nas.local:3000';
    const store = new ApiStore();
    store.register(shopProfile());

    expect(await connect(agentWith(store))).toContain('http://nas.local:3000/api/oauth/connect/shop-api');
  });

  it('reads an on-premise name with a root dot as the same address', async () => {
    // The strip on the ORIGIN host had no test: removing it moved
    // `http://nas.local.` from accepted to refused and nothing went red. Numeric
    // forms never needed it — the parser normalises `127.0.0.1.` away — so the
    // line only ever mattered for NAMES.
    // Two dots, not one: a single-dot strip passes the one-dot case and is
    // invisible, which is how the first version of this line survived.
    process.env['ORIGIN'] = 'http://nas.local..:3000';
    const store = new ApiStore();
    store.register(shopProfile());

    expect(await connect(agentWith(store))).toContain('/api/oauth/connect/shop-api');
  });

  it('accepts plain http for an address inside the operator network', async () => {
    // The common self-hosted case, and the reason the https rule is not
    // absolute: the return trip stays inside the network the operator owns.
    process.env['ORIGIN'] = 'http://localhost:3000';
    const store = new ApiStore();
    store.register(shopProfile());

    expect(await connect(agentWith(store))).toContain('http://localhost:3000/api/oauth/connect/shop-api');
  });

  it('keeps a path prefix, because an engine served under one needs it', async () => {
    // Built from the parsed URL now, and `origin` alone would have dropped this
    // silently — a link to a route that is not there.
    process.env['ORIGIN'] = 'https://tenant.lynox.example/lynox/';
    const store = new ApiStore();
    store.register(shopProfile());

    expect(await connect(agentWith(store))).toContain('https://tenant.lynox.example/lynox/api/oauth/connect/shop-api');
  });

  it('carries no secret and no state into the link', async () => {
    const store = new ApiStore();
    store.register(shopProfile());

    const result = await connect(agentWith(store));
    const link = /https:\/\/tenant\.lynox\.example\S*/.exec(result)?.[0] ?? '';

    expect(link).toBe('https://tenant.lynox.example/api/oauth/connect/shop-api');
    expect(link).not.toContain('?');
    expect(result).not.toContain(CLIENT_SECRET_VALUE);
    expect(result).not.toContain(CLIENT_ID_VALUE);
  });
});
