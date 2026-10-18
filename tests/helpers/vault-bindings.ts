/**
 * Vault-name bindings for tests whose subject is not the binding itself
 * (`src/core/vault-name-bindings.ts`).
 *
 * A send of a profile's own secret needs a binding, and in production the boot migration binds
 * every name its stored profiles agree on. A test registers its profiles after "boot", so without
 * this every such send would be refused for want of a binding, whatever the test is about. This
 * view answers as the migration would for the profiles stored at the moment of the read: a name
 * all of whose namers share one set of destinations is bound to it, a contested one to nothing.
 * What an owner's answer adds at a save (`extend`) is kept on top.
 *
 * The binding's own behaviour is tested against the real store, never through this.
 */
import type { ApiStore } from '../../src/core/api-store.js';
import type { ToolContext } from '../../src/core/tool-context.js';
import { namerDestinations } from '../../src/core/vault-name-bindings.js';

export function bindingsAsMigrated(
  apiStore: Pick<ApiStore, 'knownProfiles'> | null | undefined | (() => Pick<ApiStore, 'knownProfiles'> | null | undefined),
  /** Destinations the owner confirmed for a name, as a save the test does not run would add. Read live. */
  confirmed?: ReadonlyMap<string, readonly string[]>,
): NonNullable<ToolContext['vaultNameBindings']> {
  const extended = new Map<string, Set<string>>();
  const store = (): Pick<ApiStore, 'knownProfiles'> | null | undefined => (typeof apiStore === 'function' ? apiStore() : apiStore);
  const view = {
    boundOf(name: string): string[] {
      const s = store();
      const dests = s ? namerDestinations(s.knownProfiles(), name) : new Map<string, string[]>();
      const [only] = [...dests.values()];
      const migrated = dests.size === 1 && only !== undefined ? only : [];
      return [...new Set([...migrated, ...(extended.get(name) ?? []), ...(confirmed?.get(name) ?? [])])].sort();
    },
    extend(_owner: unknown, name: string, endpoints: readonly string[]): void {
      const set = extended.get(name) ?? new Set<string>();
      for (const e of endpoints) set.add(e);
      extended.set(name, set);
    },
    migrated: (): boolean => true,
    recordMigration: (): void => {},
  };
  return view as unknown as NonNullable<ToolContext['vaultNameBindings']>;
}
