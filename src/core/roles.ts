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
    model: 'opus',
    effort: 'max',
    autonomy: 'guided',
    denyTools: ['write_file', 'bash'],
    description: 'Thorough exploration, source citation. Read-only.',
  },
  creator: {
    model: 'sonnet',
    effort: 'high',
    autonomy: 'guided',
    denyTools: ['bash'],
    description: 'Content creation, tone adaptation. No system commands.',
  },
  operator: {
    model: 'haiku',
    effort: 'high',
    autonomy: 'autonomous',
    denyTools: ['write_file'],
    description: 'Fast status checks, concise reporting. Read-only.',
  },
  collector: {
    model: 'haiku',
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
