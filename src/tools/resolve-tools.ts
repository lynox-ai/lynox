import type { ToolEntry } from '../types/index.js';

/** The role-derived scoping `resolveTools` applies. */
export interface ToolResolutionProfile {
  readonly allowedTools?: string[] | undefined;
  readonly deniedTools?: string[] | undefined;
  /**
   * `allowedTools` is a CEILING, not a default: no other input may reach past it.
   * Set for a role that tells the model it is read-only (`RoleConfig.readOnly`).
   */
  readonly readOnly?: boolean | undefined;
}

/**
 * Resolve which tools a child agent should have access to.
 * 3-tier resolution: explicit tools > profile scoping > all parent tools.
 * @param explicitTools - If set, filter parent tools to only these names
 * @param profile - If set, apply profile's allowedTools/deniedTools (Role)
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

  const selected = selectByTier(explicitTools, profile, base);

  // The CEILING — applied after every tier, skippable by none.
  //
  // Count the inputs rather than patching the one that bit: of the four, TWO can
  // widen the result. `explicitTools` is tier 1 and returns before the profile is
  // ever read, and `profile` itself arrives from the caller. `parentTools` only
  // bounds the result and `excludeSet` only narrows it. Clamping inside a tier
  // would leave the other open, and the next caller after that — so a role whose
  // grant is a ceiling is enforced at the single exit instead, where no earlier
  // `return` can step past it. An explicit tool list may NARROW such a role; it
  // cannot widen it.
  //
  // A `readOnly` profile with no `allowedTools` resolves to nothing. That is the
  // fail-closed direction on purpose: a ceiling nobody filled in is an empty
  // ceiling, not an absent one.
  if (profile?.readOnly !== true) return selected;
  const ceiling = new Set(profile.allowedTools ?? []);
  // `deniedTools` is subtracted HERE as well, not only inside tier 2: tier 1 never
  // applied it, so a name the role denies would otherwise survive an explicit list
  // that happened to sit inside the ceiling. No current role denies a tool its own
  // ceiling holds; the exit is where that stays true without anyone checking.
  const denied = new Set(profile.deniedTools ?? []);
  return selected.filter(t => ceiling.has(t.definition.name) && !denied.has(t.definition.name));
}

/** The three tiers, unchanged. The ceiling above is the only thing outside them. */
function selectByTier(
  explicitTools: string[] | undefined,
  profile: ToolResolutionProfile | null,
  base: ToolEntry[],
): ToolEntry[] {
  // 1. Explicit tool whitelist takes precedence
  if (explicitTools) {
    const allowed = new Set(explicitTools);
    return base.filter(t => allowed.has(t.definition.name));
  }

  // 2. Profile-based scoping
  if (profile) {
    if (profile.allowedTools) {
      const allowed = new Set(profile.allowedTools);
      let filtered = base.filter(t => allowed.has(t.definition.name));
      if (profile.deniedTools) {
        const denied = new Set(profile.deniedTools);
        filtered = filtered.filter(t => !denied.has(t.definition.name));
      }
      return filtered;
    }
    if (profile.deniedTools) {
      const denied = new Set(profile.deniedTools);
      return base.filter(t => !denied.has(t.definition.name));
    }
  }

  // 3. Default: all base tools
  return base;
}
