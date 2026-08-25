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

export function pairBrandWelds(): void {
  /** The defect this module exists for: the client SECRET passed as the client id. */
  // @ts-expect-error — a swapped pair must never satisfy ClientPairNames
  const swapped: ClientPairNames = { id: GOOGLE_CLIENT_PAIR.secret, secret: GOOGLE_CLIENT_PAIR.id };
  void swapped;

  /** The old signature: two bare strings, which is what made the swap expressible. */
  // @ts-expect-error — resolveClientPair must not accept two loose name strings
  void resolveClientPair('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', {});

  /** The brands may be minted in google-client-pair.ts and nowhere else. */
  // @ts-expect-error — a hand-built descriptor cannot mint the brands
  const handBuilt: ClientPairNames = { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' };
  void handBuilt;

  // The two welds below look redundant against the ones above and are not.
  // MEASURED: with both brands in place, dropping EITHER one alone left every
  // check above still failing — the surviving brand caught the swap by itself.
  // A redundant pair reads as two guards and is one. These separate them: each
  // depends on exactly ONE brand, so removing that brand turns exactly one of
  // them green and fails the build on the unused @ts-expect-error.

  // @ts-expect-error — the ID brand may only be minted in google-client-pair.ts
  const idFromLooseString: ClientIdName = 'GOOGLE_CLIENT_ID';
  void idFromLooseString;

  // @ts-expect-error — the SECRET brand may only be minted in google-client-pair.ts
  const secretFromLooseString: ClientSecretName = 'GOOGLE_CLIENT_SECRET';
  void secretFromLooseString;
}
