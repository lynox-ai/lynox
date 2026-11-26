import { OwnerKnownTargets } from '../../src/core/owner-known-targets.js';

/**
 * A reader for a test whose subject is not the check before a send: the owner named these
 * targets (each text reads as typed by the owner), so a send to them goes on without the origin
 * question, as it would in a chat where the owner typed them.
 */
export function ownerNamed(...texts: string[]): OwnerKnownTargets {
  return OwnerKnownTargets.of({ ownerTexts: () => texts });
}
