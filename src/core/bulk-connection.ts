/**
 * Which connection a bulk target's requests carried (PRD connection-attribution A7). Its own
 * module because the client that notes the connections (`bulk-external.ts`) and the ledger that
 * stores them (`bulk-ledger.ts`) both merge them, and the client already imports the ledger.
 */

/**
 * The connection whose credential a bulk request carried: the profile's id and the grant it held
 * when its credential was read (`attachStoredCredential`). `grantId` is null when the profile held
 * none, and after {@link mergeConnections} also when the requests merged did not agree on it.
 */
export interface AttachedConnection {
  readonly id: string;
  readonly grantId: string | null;
}

/**
 * One connection for several requests made for the same target: the first one's id, and its grant
 * only while every request carried that same grant under that same id. Any disagreement leaves the
 * grant null, which a reader counts as unknown, never as one of the grants seen: a target read
 * under one grant and written under the next holds data of both. Null when nothing was attached.
 *
 * The id stays the first even when a later request came from another connection (a profile removed
 * and set up again on the same host, mid-target). Such a target is found under the first id only;
 * its null grant marks it as uncertain there.
 */
export function mergeConnections(seen: readonly (AttachedConnection | null)[]): AttachedConnection | null {
  let merged: AttachedConnection | null = null;
  for (const c of seen) {
    if (c === null) continue;
    if (merged === null) merged = { id: c.id, grantId: c.grantId };
    else if (merged.id !== c.id || merged.grantId !== c.grantId) merged = { id: merged.id, grantId: null };
  }
  return merged;
}
