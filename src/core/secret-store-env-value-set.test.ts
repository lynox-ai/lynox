import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maskEngineEnvSecrets, maskSecretsAndPatterns, registerProcessSecret } from './secret-store.js';
import { PROVIDER_KEY_SLOTS } from './llm/provider-keys.js';
import { WebPushNotificationChannel } from '../integrations/push/web-push-channel.js';

/**
 * Which values the engine masks without a store (`maskEngineEnvSecrets`): the env secrets of
 * the registry, provider keys read from the environment by slot, credentials inside a JSON env
 * value, and credentials the process loads from its own files. Every value here is made up; none
 * has a prefix a credential pattern would catch, so only the value set can mask it. Each case
 * runs a control first, without the value set, where the value must still show.
 */
describe('engine env secrets: the masked value set', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['OPENAI_API_KEY', 'GROQ_API_KEY', 'CUSTOM_API_KEY', 'LYNOX_INBOX_MISTRAL_API_KEY'])(
    'masks a provider key read from the environment as %s',
    (name) => {
      const canary = `zQ7canary${name.length}Pq9Lm2Xv4`;
      const text = `the run printed ${canary} once`;
      expect(maskEngineEnvSecrets(text), 'control: not set, not masked').toContain(canary);
      vi.stubEnv(name, canary);
      const out = maskEngineEnvSecrets(text);
      expect(out).not.toContain(canary);
      expect(out).toContain('***');
    },
  );

  it('leaves the placeholder of a local server that needs no key unmasked', () => {
    vi.stubEnv('LMSTUDIO_API_KEY', 'lm-studio');
    expect(maskEngineEnvSecrets('I run lm-studio at home')).toBe('I run lm-studio at home');
  });

  it('an array at the top level is a list of names too, and decides nothing', () => {
    const model = 'example-model-name-2026';
    vi.stubEnv('LYNOX_MODEL_PROFILES_JSON', JSON.stringify([{ tokens: { model_id: model } }]));
    expect(maskEngineEnvSecrets(`m ${model}`)).toContain(model);
  });

  it('the provider slots include the keys the catalog names', () => {
    expect(PROVIDER_KEY_SLOTS.has('OPENAI_API_KEY')).toBe(true);
    expect(PROVIDER_KEY_SLOTS.has('GROQ_API_KEY')).toBe(true);
  });

  it('masks a credential inside a JSON env value on its own, and not the model id beside it', () => {
    const leaf = 'zQ7jsonleafPq9Lm2Xv4';
    const model = 'example-model-name-2026';
    const text = `profile key ${leaf} for ${model}`;
    expect(maskEngineEnvSecrets(text), 'control').toContain(leaf);
    vi.stubEnv('LYNOX_MODEL_PROFILES_JSON', JSON.stringify({ fast: { model, api_key: leaf, base_url: 'https://example.invalid/v1' } }));
    const out = maskEngineEnvSecrets(text);
    expect(out).not.toContain(leaf);
    expect(out, 'a model id is no secret').toContain(model);
  });

  it('a credential-like profile name does not make the profile\'s other values credentials', () => {
    const leaf = 'zQ7jsonleafPq9Lm2Xv4';
    const model = 'example-model-name-2026';
    const base = 'https://example.invalid/v1';
    vi.stubEnv('LYNOX_MODEL_PROFILES_JSON', JSON.stringify({ monkey: { model_id: model, api_key: leaf, api_base_url: base }, 'token-saver': { model_id: model } }));
    const out = maskEngineEnvSecrets(`${model} at ${base} with ${leaf}`);
    expect(out).not.toContain(leaf);
    expect(out).toContain(model);
    expect(out).toContain(base);
  });

  it('masks every value nested under a credential-named property', () => {
    const nested = 'zQ7nestedleafPq9Lm2Xv4';
    vi.stubEnv('LYNOX_MODEL_PROFILES_JSON', JSON.stringify({ fast: { model_id: 'example-model-name-2026', credentials: { primary: nested } } }));
    expect(maskEngineEnvSecrets(`n ${nested}`)).not.toContain(nested);
  });

  it('masks the credential of every profile, and every value of a credential list', () => {
    const fastLeaf = 'zQ7fastleafPq9Lm2Xv4';
    const deepLeaf = 'zQ7deepleafPq9Lm2Xv4';
    const first = 'zQ7firstitemPq9Lm2Xv4';
    const second = 'zQ7seconditemPq9Lm2Xv4';
    const text = `${fastLeaf} ${deepLeaf} ${first} ${second}`;
    for (const v of [fastLeaf, deepLeaf, first, second]) expect(maskEngineEnvSecrets(text), 'control').toContain(v);
    vi.stubEnv('LYNOX_MODEL_PROFILES_JSON', JSON.stringify({
      fast: { model_id: 'example-model-name-2026', api_key: fastLeaf },
      deep: { model_id: 'example-model-name-2026', api_key: deepLeaf, credentials: [first, second] },
    }));
    const out = maskEngineEnvSecrets(text);
    for (const v of [fastLeaf, deepLeaf, first, second]) expect(out, `${v} is masked`).not.toContain(v);
  });

  it.each(['client_secret', 'access_token', 'password', 'API_KEY', 'Token'])(
    'masks a value held under a property named %s',
    (prop) => {
      const leaf = `zQ7prop${prop.length}leafPq9Lm2Xv4`;
      expect(maskEngineEnvSecrets(`p ${leaf}`), 'control').toContain(leaf);
      vi.stubEnv('LYNOX_MODEL_PROFILES_JSON', JSON.stringify({ fast: { model_id: 'example-model-name-2026', [prop]: leaf } }));
      expect(maskEngineEnvSecrets(`p ${leaf}`)).not.toContain(leaf);
    },
  );

  it('masks a value of eight characters and leaves one of seven', () => {
    const eight = 'Qx7mP2zK';
    const seven = 'Qx7mP2z';
    expect(maskEngineEnvSecrets(`v ${eight} w`), 'control').toBe(`v ${eight} w`);
    vi.stubEnv('LYNOX_VAULT_KEY', eight);
    expect(maskEngineEnvSecrets(`v ${eight} w`)).toBe('v *** w');
    vi.stubEnv('LYNOX_VAULT_KEY', seven);
    expect(maskEngineEnvSecrets(`v ${seven} w`), 'under the floor').toBe(`v ${seven} w`);
  });

  it('masks a value that overlaps itself in every occurrence', () => {
    // The value starts as it ends (`XYZ`), so its second occurrence begins inside the first.
    const value = 'XYZXYZQXYZ';
    vi.stubEnv('LYNOX_VAULT_KEY', value);
    const out = maskEngineEnvSecrets(`a ${'XYZXYZQXYZXYZQXYZ'} b`);
    expect(out).toBe('a *** b');
  });

  it('masks a text with more occurrences than a call takes arguments', () => {
    expect(maskSecretsAndPatterns('a'.repeat(400_000), ['aaaaaaaa'])).toBe('***');
  });

  it('masks two values that overlap without one inside the other, leaving no part of either', () => {
    const a = 'abcdefghXYZW';
    const b = 'XYZW12345678';
    const text = `x ${'abcdefghXYZW12345678'} y`;
    vi.stubEnv('LYNOX_VAULT_KEY', a);
    vi.stubEnv('LYNOX_HTTP_SECRET', b);
    const out = maskEngineEnvSecrets(text);
    expect(out).not.toContain('abcdefgh');
    expect(out).not.toContain('12345678');
    expect(out).toBe('x *** y');
  });

  it('masks a credential the process registered from its own file', () => {
    const canary = 'zQ7registeredPq9Lm2Xv4';
    expect(maskEngineEnvSecrets(`k ${canary}`), 'control').toContain(canary);
    registerProcessSecret(canary);
    expect(maskEngineEnvSecrets(`k ${canary}`)).not.toContain(canary);
  });

  it('masks the web push private key once the channel has loaded it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-vapid-mask-'));
    try {
      // Made up, and put together at run time: a literal of this shape reads as a key to the scanners.
      const madeUp = ['zQ7vapid', 'canary', 'Pq9Lm2Xv4Rt8'].join('');
      writeFileSync(join(dir, 'vapid-keys.json'), JSON.stringify({
        // A public key in the library's form, so the channel accepts the pair; the private one is made up.
        publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
        privateKey: madeUp,
        subject: 'mailto:notifications@example.invalid',
      }));
      expect(maskEngineEnvSecrets(`v ${madeUp}`), 'control').toContain(madeUp);
      try { new WebPushNotificationChannel(dir); } catch { /* the made-up key may be refused by the library; it was loaded first */ }
      expect(maskEngineEnvSecrets(`v ${madeUp}`)).not.toContain(madeUp);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
