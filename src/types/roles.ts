// === Roles ===

import type { ModelTier, ThinkingMode, EffortLevel } from './models.js';
import type { MemoryScopeRef } from './memory.js';
import type { AutonomyLevel } from './modes.js';

export type RoleSource = 'builtin' | 'user' | 'project';
export const OUTPUT_FORMAT_SET: ReadonlySet<string> = new Set(['text', 'json', 'markdown']);

export interface Role {
  id:          string;
  name:        string;
  description: string;
  version:     string;

  // Capability
  systemPrompt:   string;
  allowedTools?:  string[] | undefined;
  deniedTools?:   string[] | undefined;
  outputFormat?:  'text' | 'json' | 'markdown' | undefined;
  memoryScope?:   MemoryScopeRef | undefined;

  // Autonomy
  autonomy?:  AutonomyLevel | undefined;

  // Tuning
  model?:         ModelTier | undefined;
  thinking?:      ThinkingMode | undefined;
  effort?:        EffortLevel | undefined;
  maxIterations?: number | undefined;
  maxBudgetUsd?:  number | undefined;

  // Meta
  extends?: string | undefined;
  tags?:    string[] | undefined;
  source?:  RoleSource | undefined;
}

// === Playbooks ===

export type PlaybookSource = 'builtin' | 'user' | 'project';

export interface PlaybookParameter {
  name:          string;
  description:   string;
  type:          'string' | 'number' | 'date' | 'boolean';
  required:      boolean;
  defaultValue?: unknown | undefined;
}

export interface PlaybookPhase {
  name:             string;
  description:      string;
  recommendedRole?: string | undefined;
  verification?:    string | undefined;
  dependsOn?:       string[] | undefined;
}

export interface Playbook {
  id:              string;
  name:            string;
  description:     string;
  version:         string;
  phases:          PlaybookPhase[];
  parameters?:     PlaybookParameter[] | undefined;
  applicableWhen?: string | undefined;

  // Meta
  extends?: string | undefined;
  tags?:    string[] | undefined;
  source?:  PlaybookSource | undefined;
}

export interface ToolScopeConfig {
  allowedTools?: string[] | undefined;
  deniedTools?:  string[] | undefined;
}

export interface BatchRequest {
  id:      string;
  task:    string;
  system?: string | undefined;
  label?:  string | undefined;
}

export type { BatchEntry } from '../core/batch-index.js';

export interface BatchResult {
  id:      string;
  status:  'succeeded' | 'errored' | 'expired' | 'canceled';
  result?: string | undefined;
  error?:  string | undefined;
}
