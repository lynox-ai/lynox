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
 * The `deep` tier is a Managed-Pro billing entitlement (managed_pro pays for the
 * Opus class). A **managed-standard** caller (`account_tier === 'standard'`) who
 * explicitly asks for `model: 'deep'` is silently downgraded to `balanced` and a
 * warning is written to stderr — the lower managed tier shouldn't burn deep-tier
 * budget on a per-spawn opt-in.
 *
 * Self-host / BYOK callers (`account_tier` **unset**) pay their own LLM bill, so
 * they are NOT gated — an unset tier passes the override through unchanged.
 * managed_pro passes too. Only an explicit OVERRIDE is gated;
 * `requestedModel === undefined` means "no override" → returns undefined so the
 * caller falls through to the role's default untouched.
 *
 * Keep this the single place that knows the rule; the model resolver
 * (`tier-resolver.ts`) and any other callers delegate.
 */
export function applyTierGate(
  requestedModel: ModelTier | undefined,
  accountTier: AccountTier | undefined,
): ModelTier | undefined {
  if (requestedModel === 'deep' && accountTier === 'standard') {
    process.stderr.write(
      `[role-gate] deep-tier override requires account_tier=pro — downgrading to balanced\n`,
    );
    return 'balanced';
  }
  return requestedModel;
}
