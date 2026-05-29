/**
 * Built-in roles for spawn_agent and pipeline steps.
 * Simplified from the previous file-based resolution system.
 * 4 roles covering distinct cost/capability combinations.
 */

import type { ModelTier, EffortLevel, AutonomyLevel } from '../types/index.js';

export interface RoleConfig {
  readonly model: ModelTier;
  readonly effort: EffortLevel;
  readonly autonomy: AutonomyLevel;
  readonly denyTools?: readonly string[] | undefined;
  readonly allowTools?: readonly string[] | undefined;
  readonly description: string;
}

export const BUILTIN_ROLES: Record<string, RoleConfig> = {
  researcher: {
    // Default is the `balanced` tier for all accounts — bench (2026-04) showed
    // the balanced tier + adaptive-thinking matches the `deep` tier on
    // deep-research tasks at a fraction of the cost. Managed-Pro tenants can
    // still override via explicit `model: 'deep'` on the spawn call;
    // `applyTierGate` below downgrades that override to `balanced` for non-Pro
    // tenants so Starter/Managed accounts can't burn the deep-tier budget by
    // accident.
    model: 'balanced',
    effort: 'max',
    autonomy: 'guided',
    denyTools: ['write_file', 'bash'],
    description: 'Thorough exploration, source citation. Read-only.',
  },
  creator: {
    model: 'balanced',
    effort: 'high',
    autonomy: 'guided',
    denyTools: ['bash'],
    description: 'Content creation, tone adaptation. No system commands.',
  },
  operator: {
    model: 'fast',
    effort: 'high',
    autonomy: 'autonomous',
    denyTools: ['write_file'],
    description: 'Fast status checks, concise reporting. Read-only.',
  },
  collector: {
    model: 'fast',
    effort: 'medium',
    autonomy: 'supervised',
    allowTools: ['ask_user', 'memory_store', 'memory_recall'],
    description: 'Structured Q&A with user. Minimal tools.',
  },
};

/** Get a role config by name. Returns undefined if not found. */
export function getRole(name: string): RoleConfig | undefined {
  return BUILTIN_ROLES[name];
}

/** List all available role names. */
export function getRoleNames(): string[] {
  return Object.keys(BUILTIN_ROLES);
}

export type AccountTier = 'standard' | 'pro';

/**
 * Gate an explicit model override by the caller's account tier.
 *
 * Today's only rule: the `deep` tier is a Managed-Pro-only capability. If a
 * non-Pro caller asks for `model: 'deep'`, we silently downgrade to the
 * `balanced` tier and emit a warning on stderr — the Starter/Managed tiers
 * shouldn't burn deep-tier budget on a per-spawn opt-in.
 *
 * Keep this function the single place that knows the rule; spawn tool
 * + any other callers delegate. `requestedModel === undefined` means
 * "no override, use the role's default" — returns undefined so the
 * caller falls back to RoleConfig.model.
 */
export function applyTierGate(
  requestedModel: ModelTier | undefined,
  accountTier: AccountTier | undefined,
): ModelTier | undefined {
  if (requestedModel === 'deep' && accountTier !== 'pro') {
    process.stderr.write(
      `[role-gate] deep-tier override requires account_tier=pro — downgrading to balanced\n`,
    );
    return 'balanced';
  }
  return requestedModel;
}
