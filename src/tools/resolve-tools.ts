import type { ToolEntry } from '../types/index.js';

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
  profile: { allowedTools?: string[] | undefined; deniedTools?: string[] | undefined } | null,
  parentTools: ToolEntry[],
  excludeSet?: ReadonlySet<string>,
): ToolEntry[] {
  const base = excludeSet
    ? parentTools.filter(t => !excludeSet.has(t.definition.name))
    : parentTools;

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
