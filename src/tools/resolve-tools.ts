import type { ToolEntry } from '../types/index.js';

/** The role-derived scoping `resolveTools` applies. */
export interface ToolResolutionProfile {
  /**
   * The role's own upper bound. `undefined` means the role declared none; `[]` is a
   * declared bound that admits nothing. The two are NOT the same value here — see
   * `profileCeiling`.
   */
  readonly allowedTools?: string[] | undefined;
  readonly deniedTools?: string[] | undefined;
  /**
   * Set for a role that tells the model it is read-only (`RoleConfig.readOnly`).
   *
   * It no longer decides WHETHER the role's grant binds — that holds for every
   * profile. It decides what an ABSENT `allowedTools` means: for a read-only role a
   * bound nobody filled in is an empty bound, and the grant resolves to nothing.
   */
  readonly readOnly?: boolean | undefined;
}

/**
 * Resolve which tools a child agent should have access to.
 *
 * Two steps, and the order is the contract: the caller's own list NARROWS the parent
 * set, then the role's grant BOUNDS whatever that produced. An explicit tool list can
 * therefore ask for less than its role allows and never for more.
 *
 * @param explicitTools - If set, narrow the parent tools to these names
 * @param profile - If set, the role's grant: `allowedTools` bounds, `deniedTools` subtracts
 * @param parentTools - Full set of parent tools
 * @param excludeSet - Tool names to always exclude (e.g. spawn_agent)
 */
export function resolveTools(
  explicitTools: string[] | undefined,
  profile: ToolResolutionProfile | null,
  parentTools: ToolEntry[],
  excludeSet?: ReadonlySet<string>,
): ToolEntry[] {
  const base = excludeSet
    ? parentTools.filter(t => !excludeSet.has(t.definition.name))
    : parentTools;

  // The caller's list, which may name fewer tools than the parent has and may name
  // some the parent does not carry. `[]` empties the request on purpose: a step or
  // spawn that declares no tools is asking for none.
  let requested = base;
  if (explicitTools) {
    const named = new Set(explicitTools);
    requested = base.filter(t => named.has(t.definition.name));
  }

  // The BOUND — applied after the request, skippable by no route in.
  //
  // Count the inputs rather than patching the one that bit: of the four, TWO can
  // widen the result. `explicitTools` arrives from the caller and used to be a tier
  // that returned before the profile was ever read, and `profile` itself arrives
  // from the caller too. `parentTools` only bounds the result and `excludeSet` only
  // narrows it. Bounding inside the request would leave the other input open, and
  // the next caller after that — so the role's grant is applied at the single exit,
  // where no earlier `return` can step past it.
  //
  // This binds for EVERY profile, and keying it on `readOnly` is what it replaces.
  // That key held the two roles carrying the flag and left the other two to the
  // caller's list: one with a denylist, one with an allowlist and no denylist at
  // all. So no set drawn around `denyTools` would have covered the second — the
  // shape that leaks is "a role states a grant", not "a role denies a tool".
  const ceiling = profileCeiling(profile);
  const denied = new Set(profile?.deniedTools ?? []);
  return requested.filter(
    t => (ceiling === null || ceiling.has(t.definition.name)) && !denied.has(t.definition.name),
  );
}

/**
 * Every tool in `derived` is one that `parent` holds.
 *
 * The invariant every route that builds a tool list for a child agent owes, stated as a
 * predicate rather than as a comment above each route. Pure and exported for two reasons:
 * a test asserts the PROPERTY on a route's real output instead of re-implementing the
 * comparison, and a mutant that routes around the bound then fails on this assertion rather
 * than on a count that could move for other reasons.
 *
 * It is deliberately about NAMES, not identity: a route may hand on the same tool object or
 * a filtered copy, and both are the same grant.
 */
export function withinSurface(derived: ToolEntry[], parent: ToolEntry[]): boolean {
  const held = new Set(parent.map(t => t.definition.name));
  return derived.every(t => held.has(t.definition.name));
}

/**
 * The role's upper bound as a set, or `null` when the role declared none.
 *
 * Read the two absent-ish values apart before touching this: `allowedTools: []` is a
 * bound that admits nothing, `allowedTools: undefined` is no bound at all — and a
 * `?? []` over both is what turns every role without an allowlist into a role with
 * no tools. `readOnly` is the one case where the undefined value still means empty,
 * because a read-only label with an unfilled bound should fail closed rather than
 * grant the parent's whole set.
 */
function profileCeiling(profile: ToolResolutionProfile | null): ReadonlySet<string> | null {
  // `undefined` as well as `null`, because the line that reads `deniedTools` beside this
  // one optional-chains and this one dereferences: one half of the same function
  // tolerating a value the other throws on is the asymmetry, not the type signature.
  // Neither caller passes it; a third one written in JS would have found the difference.
  if (profile === null || profile === undefined) return null;
  if (profile.allowedTools !== undefined) return new Set(profile.allowedTools);
  return profile.readOnly === true ? new Set<string>() : null;
}
