/**
 * ToolContext — shared context for tool handlers.
 *
 * Replaces closure-based module-level state setters (setDataStore, etc.)
 * with a single context object scoped to the Lynox orchestrator instance.
 *
 * The orchestrator creates one ToolContext and passes it to each Agent.
 * Tool handlers read from `agent.toolContext` instead of module-level variables.
 * Properties are mutable so the orchestrator can update them without recreating the agent.
 */
import type { DataStore } from './data-store.js';
import type { TaskManager } from './task-manager.js';
import type { RunHistory } from './run-history.js';
import type {
  IKnowledgeLayer,
  LynoxUserConfig,
  ToolEntry,
  StreamHandler,
  NetworkPolicy,
} from '../types/index.js';

/** Provider for cross-session HTTP rate limiting (implemented by RunHistory). */
export interface ToolCallCountProvider {
  getToolCallCountSince(toolName: string, hours: number): number;
}

export interface ToolContext {
  // ── Core dependencies ──
  dataStore: DataStore | null;
  taskManager: TaskManager | null;
  knowledgeLayer: IKnowledgeLayer | null;
  runHistory: RunHistory | null;
  userConfig: LynoxUserConfig;

  // ── Pipeline / process ──
  tools: ToolEntry[];
  streamHandler: StreamHandler | null;

  // ── Network policy (http tool) ──
  networkPolicy: NetworkPolicy | undefined;
  allowedHosts: ReadonlySet<string> | undefined;
  allowedWildcards: string[];
  rateLimitProvider: ToolCallCountProvider | null;
  hourlyRateLimit: number;
  dailyRateLimit: number;

  // ── API Store (per-API rate limiting + knowledge) ──
  apiStore: import('./api-store.js').ApiStore | null;

  // ── Artifact Store ──
  artifactStore: import('./artifact-store.js').ArtifactStore | null;

  // ── Isolation (bash tool) ──
  isolationEnvOverride: Record<string, string> | undefined;
  isolationMinimalEnv: boolean;

  // ── Tracked plan execution ──
  activePlan: ActiveTrackedPlan | null;
}

export interface TrackedStepResult {
  stepId: string;
  status: 'completed' | 'failed' | 'skipped';
  summary: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface ActiveTrackedPlan {
  pipelineId: string;
  name: string;
  goal: string;
  steps: Array<{ id: string; task: string; inputFrom?: string[] | undefined }>;
  startedAt: string;
  stepResults: Map<string, TrackedStepResult>;
}

/** Create a default (empty) ToolContext. */
export function createToolContext(userConfig: LynoxUserConfig): ToolContext {
  return {
    dataStore: null,
    taskManager: null,
    knowledgeLayer: null,
    runHistory: null,
    userConfig,
    tools: [],
    streamHandler: null,
    networkPolicy: undefined,
    allowedHosts: undefined,
    allowedWildcards: [],
    rateLimitProvider: null,
    hourlyRateLimit: Infinity,
    dailyRateLimit: Infinity,
    apiStore: null,
    artifactStore: null,
    isolationEnvOverride: undefined,
    isolationMinimalEnv: false,
    activePlan: null,
  };
}

/**
 * Apply network policy to a ToolContext.
 * Splits wildcard hosts (*.example.com) from exact hosts.
 */
export function applyNetworkPolicy(
  ctx: ToolContext,
  policy: NetworkPolicy | undefined,
  hosts: string[] | undefined,
): void {
  ctx.networkPolicy = policy;
  if (hosts && hosts.length > 0) {
    const exact = new Set<string>();
    const wildcards: string[] = [];
    for (const h of hosts) {
      if (h.startsWith('*.')) {
        wildcards.push(h.slice(2));
      } else {
        exact.add(h);
      }
    }
    ctx.allowedHosts = exact;
    ctx.allowedWildcards = wildcards;
  } else {
    ctx.allowedHosts = undefined;
    ctx.allowedWildcards = [];
  }
}

/**
 * Configure cross-session HTTP rate limits on a ToolContext.
 */
export function applyHttpRateLimits(
  ctx: ToolContext,
  provider: ToolCallCountProvider,
  hourlyLimit?: number,
  dailyLimit?: number,
): void {
  ctx.rateLimitProvider = provider;
  ctx.hourlyRateLimit = hourlyLimit ?? Infinity;
  ctx.dailyRateLimit = dailyLimit ?? Infinity;
}
