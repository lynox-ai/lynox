import { describe, expect, it } from 'vitest';
import { resolveInboxMistralKey } from './mistral-key.js';

const vault = (entries: Record<string, string>) => ({ resolve: (name: string): string | null => entries[name] ?? null });

describe('resolveInboxMistralKey', () => {
  it('on a pool tier takes the environment\'s key, not the vault copy, and the pool pays', () => {
    expect(resolveInboxMistralKey(vault({ MISTRAL_API_KEY: 'own' }), { MISTRAL_API_KEY: 'pool' }, true))
      .toEqual({ key: 'pool', poolPays: true });
  });

  it('on a pool tier without the environment\'s key has none, even with a vault copy', () => {
    expect(resolveInboxMistralKey(vault({ MISTRAL_API_KEY: 'own' }), {}, true)).toEqual({ key: undefined, poolPays: false });
  });

  it('on a pool tier takes a key set for the inbox, from the vault or the environment, and the user pays', () => {
    expect(resolveInboxMistralKey(vault({ LYNOX_INBOX_MISTRAL_API_KEY: 'inbox' }), { MISTRAL_API_KEY: 'pool' }, true))
      .toEqual({ key: 'inbox', poolPays: false });
    expect(resolveInboxMistralKey(vault({}), { LYNOX_INBOX_MISTRAL_API_KEY: 'inbox-env', MISTRAL_API_KEY: 'pool' }, true))
      .toEqual({ key: 'inbox-env', poolPays: false });
  });

  it('off a pool tier keeps the order: vault inbox key, vault key, environment inbox key, environment key', () => {
    const env = { LYNOX_INBOX_MISTRAL_API_KEY: 'env-inbox', MISTRAL_API_KEY: 'env' };
    expect(resolveInboxMistralKey(vault({ LYNOX_INBOX_MISTRAL_API_KEY: 'v-inbox', MISTRAL_API_KEY: 'v' }), env, false).key).toBe('v-inbox');
    expect(resolveInboxMistralKey(vault({ MISTRAL_API_KEY: 'v' }), env, false).key).toBe('v');
    expect(resolveInboxMistralKey(vault({}), env, false).key).toBe('env-inbox');
    expect(resolveInboxMistralKey(vault({}), { MISTRAL_API_KEY: 'env' }, false)).toEqual({ key: 'env', poolPays: false });
  });
});
