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
 * Resolve an explicit model override. Historically this GATED the `deep` tier
 * behind a Managed-Pro entitlement — a managed-standard caller asking for
 * `model: 'deep'` was silently downgraded to `balanced`.
 *
 * That capability gate is RETIRED (D8, 2026-06-17). With the flexible Tier-Set,
 * gating the tier BAND is incoherent: `deep` no longer means "Opus" (a tenant
 * can map it to a cheap Mistral-Large), so a band gate would wrongly block a
 * cheap deep tier while a band-allowed model could be the expensive one. Cost is
 * controlled where it actually lives — the included BUDGET (overdraft cap →
 * block/suspend, `usage.ts`) + per-model cost transparency in the settings UI —
 * not by an arbitrary tier lock. So this is now a PASS-THROUGH: any account may
 * request any tier.
 *
 * Kept as the single seam every model-resolution path delegates through (rather
 * than inlined/deleted) so any future policy stays a one-line change here; the
 * `_accountTier` param is retained for caller stability + that forward-compat.
 */
export function applyTierGate(
  requestedModel: ModelTier | undefined,
  _accountTier: AccountTier | undefined,
): ModelTier | undefined {
  return requestedModel;
}
