/**
 * The vault as the engine reads it for one API profile (PRD customer-granted-operator-access
 * §3.13, H2).
 *
 * The engine resolves a profile's credentials itself: the attach on every `http_request` to
 * its host, the token renewal, `api_setup fetch_token`. The names come from the profile, so
 * whoever wrote the profile chose them. For a profile a mandate wrote, that choice is not
 * enough: a value the engine took from its environment, and the credentials of an account
 * connected through a provider preset, are not the mandate's to send anywhere. This view
 * hides them from those reads. It applies to the profile, not to the turn, because the
 * owner's own runs reach a mandate's profile as well.
 *
 * A profile without a mandate author gets the store itself, unchanged.
 */
import type { SecretStoreLike } from '../types/index.js';
import { isMandateAuthored, presetCredentialNames } from './api-store.js';
import type { ApiProfile, ApiStore } from './api-store.js';

export function secretsForProfile(
  store: SecretStoreLike,
  profile: ApiProfile,
  apiStore: Pick<ApiStore, 'getAll'>,
): SecretStoreLike {
  if (!isMandateAuthored(profile)) return store;
  // Read at each lookup, not once: the owner can connect a preset after the mandate's
  // profile already names its token.
  const hidden = (name: string): boolean =>
    (store.isEnvironmentSecret?.(name) ?? true) || presetCredentialNames(apiStore).has(name);
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'resolve') {
        return (name: string): string | null => (hidden(name) ? null : target.resolve(name));
      }
      if (prop === 'resolveSecretRefs') {
        // Nothing is resolved when any name is hidden: the callers probe one name at a time,
        // and a partly resolved input is not one any of them expects.
        return (input: unknown): unknown =>
          target.extractSecretNames(input).some(hidden) ? input : target.resolveSecretRefs(input);
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
