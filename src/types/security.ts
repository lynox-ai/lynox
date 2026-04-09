// === Sealed Secrets ===

import type { MemoryScopeRef } from './memory.js';

export type SecretScope = 'http_header' | 'http_body' | 'bash_env' | 'any';

export interface SecretEntry {
  name: string;
  maskedValue: string;
  scope: SecretScope;
  consentedAt?: string | undefined;
  expiresAt?: string | undefined;
}

export interface SecretStoreLike {
  getMasked(name: string): string | null;
  resolve(name: string): string | null;
  listNames(): string[];
  containsSecret(text: string): boolean;
  maskSecrets(text: string): string;
  recordConsent(name: string): void;
  hasConsent(name: string): boolean;
  isExpired(name: string): boolean;
  extractSecretNames(input: unknown): string[];
  resolveSecretRefs(input: unknown): unknown;
  set?(name: string, value: string, scope?: SecretScope, ttlMs?: number): void;
  deleteSecret?(name: string): boolean;
}

// === Pipeline Cost Estimation ===

export interface StepCostEstimate {
  stepId: string;
  model: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
}

export interface PipelineCostEstimate {
  steps: StepCostEstimate[];
  totalCostUsd: number;
}

// === Isolation & Tenants (Phase 3) ===

export type IsolationLevel = 'shared' | 'scoped' | 'sandboxed' | 'air-gapped';
export type NetworkPolicy = 'allow-all' | 'allow-list' | 'deny-all';
export type HistoryAccess = 'none' | 'own' | 'all';

// === Isolation (shared types — enforcement in lynox-pro) ===
export interface IsolationConfig {
  level: IsolationLevel;
  memoryScopes?: MemoryScopeRef[] | undefined;
  historyAccess?: HistoryAccess | undefined;
  workspaceDir?: string | undefined;
  envVars?: Record<string, string> | undefined;
  networkPolicy?: NetworkPolicy | undefined;
  allowedHosts?: string[] | undefined;
}

// === Changeset Manager ===

export interface ChangesetEntry {
  filePath: string;              // absolute path of the written file
  originalContent: string | null; // null = file didn't exist (new file)
  status: 'added' | 'modified';
}

export interface ChangesetDiff {
  file: string;                  // relative path for display
  absolutePath: string;
  status: 'added' | 'modified';
  diff: string;                  // unified diff text
  originalContent: string | null;
}

export interface ChangesetResult {
  action: 'accept' | 'rollback' | 'partial';
  acceptedFiles: string[];
  rolledBackFiles: string[];
}
