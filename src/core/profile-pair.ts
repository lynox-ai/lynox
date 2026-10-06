/**
 * A model profile pins endpoint AND model as one pair — the one place that rule
 * is read when a caller inherits another agent's provider config.
 *
 * Several call sites take a calling agent's `getProviderConfig()` snapshot (its
 * endpoint, key and `openaiModelId`) and build a client from it, then pick the
 * model from the tier resolver. When that agent was built from a profile, the
 * endpoint serves only the profile's model, and a tier id sent there is a request
 * for a model the host does not serve (a Fireworks id at a Mistral endpoint, a 400).
 * Those sites ask here which model goes with the client they inherited.
 *
 * Two carriers, because the snapshot does not always travel as itself:
 *  - the snapshot (`ProviderConfigSnapshot.modelPinnedByProfile`), read with
 *    {@link pinnedModelOf};
 *  - a `LynoxUserConfig` overlay built from such a snapshot (the workflow steps
 *    read their endpoint from `config.api_base_url`), marked with
 *    {@link pinConfigModel} and read with {@link pinnedModelOfConfig}. The mark is
 *    a symbol-keyed property: it survives the object spreads the overlay goes
 *    through, and no config file or JSON body can set it.
 */
import type { ProviderConfigSnapshot } from '../types/agent.js';

/**
 * The model a client built from `snapshot` must send, or `undefined` when the
 * snapshot is not pinned to a profile — then the caller's own (tier) choice
 * stands, exactly as before.
 */
export function pinnedModelOf(snapshot: ProviderConfigSnapshot | null | undefined): string | undefined {
  return snapshot?.modelPinnedByProfile === true && snapshot.openaiModelId ? snapshot.openaiModelId : undefined;
}

const PINNED_MODEL: unique symbol = Symbol('lynox.profilePinnedModel');

type Pinnable = object & { [PINNED_MODEL]?: string | undefined };

/** Mark a config overlay built from a pinned snapshot. Returns the same object. */
export function pinConfigModel<T extends object>(config: T, modelId: string | undefined): T {
  if (modelId) (config as Pinnable)[PINNED_MODEL] = modelId;
  return config;
}

/** The model a config overlay is pinned to, or `undefined`. */
export function pinnedModelOfConfig(config: object): string | undefined {
  return (config as Pinnable)[PINNED_MODEL];
}
