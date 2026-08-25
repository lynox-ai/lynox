/**
 * Compile welds for the credential-pair brands.
 *
 * A source file on purpose, and the reason is measured rather than stylistic:
 * `tsconfig.json` includes `src` but EXCLUDES `src/**\/*.test.ts`, and
 * `tsconfig.tests.json` covers only `tests/security` and
 * `tests/contract-env.test.ts`. A `@ts-expect-error` living in a
 * `src/**\/*.test.ts` is compiled by NEITHER run — it looks like an assertion
 * and proves nothing. `src/contract/fixtures/mirrors.ts` says the same in its
 * own header, for the same reason.
 *
 * Every statement below must stay a type ERROR, and that direction is what
 * makes the weld self-guarding: if a change makes one legal, tsc fails on the
 * now-unused `@ts-expect-error`. A weld cannot rot into a silent no-op — it can
 * only turn red.
 *
 * The checks live inside a function that is exported and NEVER CALLED. That is
 * not a style choice either: the first version used `declare const`, which
 * type-checks and does not exist at runtime, so importing this module threw.
 * Nothing imported it, so nothing noticed — the file was broken and green at
 * the same time. `tests/contract-env.test.ts` now imports the function, which
 * is what makes deleting this file a failure instead of a silent loss.
 *
 * Ships compiled in `dist/` as an uncalled function — the same trade
 * `mirrors.ts` makes, and for the same reason: a weld that is not in the
 * build is not checked by the build.
 */
import {
  resolveClientPair,
  GOOGLE_CLIENT_PAIR,
  type ClientPairNames,
  type ClientIdName,
  type ClientSecretName,
} from './google-client-pair.js';

/**
 * A second provider's pair, minted exactly as a real one would be.
 *
 * It exists so the FOREIGN-PARTNER case is expressible at all. With one pair in
 * the tree there is no second `ClientSecretName` to mis-pair with, so the guard
 * against mixing two credentials could not be exercised — an untestable guard
 * and an absent one read the same from here. This fixture is the second pair,
 * ahead of the real one.
 */
const OTHER_PROVIDER_PAIR = {
  id: 'MS_CLIENT_ID' as ClientIdName,
  secret: 'MS_CLIENT_SECRET' as ClientSecretName,
} as ClientPairNames;

export function pairBrandWelds(): void {
  // ── Independently killable: each of the three below dies to exactly one
  // removal, which is what makes them guards rather than commentary.

  /**
   * The PAIR brand. Two correctly branded members from DIFFERENT credentials —
   * the mix core#1269 exists against, re-assembled by the caller instead of by
   * the precedence chain. Killed by removing `[CLIENT_PAIR_BRAND]` from the
   * interface: the literal then satisfies it and the suppression goes unused.
   */
  // @ts-expect-error — members of two different pairs cannot form a pair
  const foreignPartner: ClientPairNames = { id: GOOGLE_CLIENT_PAIR.id, secret: OTHER_PROVIDER_PAIR.secret };
  void foreignPartner;

  /**
   * The ID brand alone. MEASURED before this split existed: with both member
   * brands in place, dropping EITHER one left every whole-descriptor check
   * still failing, because the surviving brand caught the swap by itself — a
   * redundant pair that reads as two guards and is one.
   */
  // @ts-expect-error — the ID brand cannot be minted from a loose string
  const idFromLooseString: ClientIdName = 'GOOGLE_CLIENT_ID';
  void idFromLooseString;

  /** The SECRET brand alone, for the same reason and killed by the same cut. */
  // @ts-expect-error — the SECRET brand cannot be minted from a loose string
  const secretFromLooseString: ClientSecretName = 'GOOGLE_CLIENT_SECRET';
  void secretFromLooseString;

  // ── NOT independently killable, and kept anyway — as the record of the
  // defect, not as coverage. Each of the three below stays a type error under
  // the removal of ANY SINGLE brand, because the remaining brands still reject
  // it. Saying so here is the point: a weld nobody can kill looks exactly like
  // a weld that works, and the mutation table must not count these as kills.

  /** The defect this module exists for: the client SECRET passed as the client id. */
  // @ts-expect-error — a swapped pair must never satisfy ClientPairNames
  const swapped: ClientPairNames = { id: GOOGLE_CLIENT_PAIR.secret, secret: GOOGLE_CLIENT_PAIR.id };
  void swapped;

  /** The old signature: two bare strings, which is what made the swap expressible. */
  // @ts-expect-error — resolveClientPair must not accept two loose name strings
  void resolveClientPair('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', {});

  /** A descriptor assembled by hand, from loose strings, at a call site. */
  // @ts-expect-error — a hand-built descriptor cannot mint the brands
  const handBuilt: ClientPairNames = { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' };
  void handBuilt;
}
