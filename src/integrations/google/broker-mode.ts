// === The broker-mode predicate, in ONE place ===
//
// "Is this tenant on lynox's shared Google client?" is asked by the status
// route, by `POST /api/google/auth` (which must refuse a scope request it
// cannot serve) and by the tool refusals. It had three different wrong answers
// before this module existed:
//
//  - `isManagedBrokerPair(source)` needs `source === 'env'`, and a brokered
//    tenant has NO pair at all, so it is false exactly where it is needed;
//  - "the control-plane identity" alone classifies a managed tenant that
//    brought its OWN Google client as brokered, and would refuse its `/auth`;
//  - `client_source === null` alone is true on any unconfigured self-host box.
//
// The predicate is the CONJUNCTION: a provisioned instance on which no client
// pair resolves. The absence of a pair is the mode.

import type { ClientPairSource } from '../../core/google-client-pair.js';

/**
 * Whether this process is a tenant the control plane provisioned.
 *
 * ⚠ An EMPTY marker is not a marker. `LYNOX_MANAGED_INSTANCE_ID=''` is what a
 * half-written env file produces, and `!== undefined` would read it as "yes,
 * managed" — putting a self-host box with an empty variable into broker mode,
 * where `/auth` refuses and the card offers a button that goes nowhere.
 */
export function isProvisionedInstance(): boolean {
  const id = process.env['LYNOX_MANAGED_INSTANCE_ID'];
  return typeof id === 'string' && id.length > 0;
}

/** A provisioned instance on which no client pair resolves. */
export function isBrokerMode(clientSource: ClientPairSource | null): boolean {
  return isProvisionedInstance() && clientSource === null;
}
