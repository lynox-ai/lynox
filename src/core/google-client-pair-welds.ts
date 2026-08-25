/**
 * Compile welds for the credential-pair brands.
 *
 * A source file on purpose, and measured rather than stylistic: `tsconfig.json`
 * excludes `src/**` + `/*.test.ts`, and `tsconfig.tests.json` names only
 * `tests/security`, `tests/contract-env.test.ts` and the two
 * `tests/eval/probe-freshness*` files. A `@ts-expect-error` inside a
 * `src/**` + `/*.test.ts` is compiled by NEITHER run — it reads as an assertion
 * and proves nothing.
 *
 * `@ts-expect-error` suppresses ANY error, not the one its comment names, so a
 * weld can pass for the wrong reason. That is not hypothetical: the legacy-
 * signature check below used to call the resolver with three arguments, where
 * the arity error fired before any brand was consulted and the weld stayed green
 * with every brand deleted. Keep each fixture narrow enough that only one error
 * is possible.
 *
 * The checks live in an exported, never-called function. The first version used
 * `declare const`, which type-checks and does not exist at runtime, so importing
 * the module threw — and nothing imported it, so the file was broken and green at
 * the same time. `tests/contract-env.test.ts` imports the function; that is what
 * makes deleting this file a failure rather than a silent loss.
 */
import {
  resolveClientPair,
  GOOGLE_CLIENT_PAIR,
  type ClientPairNames,
  type ClientIdName,
  type ClientSecretName,
} from './google-client-pair.js';

/**
 * A second provider's pair, minted exactly as a real one would be. It exists so
 * the foreign-partner case is expressible at all: with one pair in the tree
 * there is no other `ClientSecretName` to mis-pair with, and an untestable guard
 * reads the same as an absent one.
 */
const OTHER_PROVIDER_PAIR = { id: 'MS_CLIENT_ID', secret: 'MS_CLIENT_SECRET' } as ClientPairNames;

export function pairBrandWelds(): void {
  // ── Independently killable. Each dies to exactly one removal.

  /** The PAIR brand: two correctly branded members from DIFFERENT credentials. */
  // @ts-expect-error — members of two different pairs cannot form a pair
  const foreignPartner: ClientPairNames = { id: GOOGLE_CLIENT_PAIR.id, secret: OTHER_PROVIDER_PAIR.secret };
  void foreignPartner;

  /** The signature itself: the first parameter must not go back to a name string. */
  // @ts-expect-error — the first parameter is a descriptor, not a name
  const legacyFirstArg: Parameters<typeof resolveClientPair>[0] = 'GOOGLE_CLIENT_ID';
  void legacyFirstArg;

  /**
   * The ID brand alone. Separated because with both member brands in place,
   * dropping either one left every whole-descriptor check below still failing —
   * the surviving brand caught the swap by itself, so the pair read as two
   * guards and was one.
   */
  // @ts-expect-error — the ID brand cannot be minted from a loose string
  const idFromLooseString: ClientIdName = 'GOOGLE_CLIENT_ID';
  void idFromLooseString;

  /** The SECRET brand alone, for the same reason and killed by the same cut. */
  // @ts-expect-error — the SECRET brand cannot be minted from a loose string
  const secretFromLooseString: ClientSecretName = 'GOOGLE_CLIENT_SECRET';
  void secretFromLooseString;

  // ── NOT independently killable, kept as the record of the defect rather than
  // as coverage: each stays a type error under the removal of any single brand,
  // because the remaining brands still reject it. The mutation table must not
  // count these as kills.

  /** The defect this module exists for: the client SECRET passed as the client id. */
  // @ts-expect-error — a swapped pair must never satisfy ClientPairNames
  const swapped: ClientPairNames = { id: GOOGLE_CLIENT_PAIR.secret, secret: GOOGLE_CLIENT_PAIR.id };
  void swapped;

  /** A descriptor assembled by hand, from loose strings, at a call site. */
  // @ts-expect-error — a hand-built descriptor cannot mint the brands
  const handBuilt: ClientPairNames = { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' };
  void handBuilt;
}
