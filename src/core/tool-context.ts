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
import type { CRM } from './crm.js';
import type { TaskManager } from './task-manager.js';
import type { RunHistory } from './run-history.js';
import type { SubjectStore } from './subject-store.js';
import type { ThreadStore } from './thread-store.js';
import type { HookHost } from './metered-request.js';
import type {
  IKnowledgeLayer,
  LynoxUserConfig,
  ToolEntry,
  StreamHandler,
  NetworkPolicy,
  StepHint,
} from '../types/index.js';

/** Provider for cross-session HTTP rate limiting (implemented by RunHistory). */
export interface ToolCallCountProvider {
  getToolCallCountSince(toolName: string, hours: number): number;
}

export interface ToolContext {
  // ── Core dependencies ──
  dataStore: DataStore | null;
  /** Contact management (thin typed surface over DataStore). Wired after
   *  CRM init so the `contacts_save`/`contacts_search` tools write into the
   *  correct global CRM scope + schema. Null when DataStore is unavailable. */
  crm: CRM | null;
  taskManager: TaskManager | null;
  knowledgeLayer: IKnowledgeLayer | null;
  runHistory: RunHistory | null;
  userConfig: LynoxUserConfig;
  /** Foundation Rework v2 — Context-Hierarchy Scoping (Slice A2). Subject-graph
   *  read/write + the live thread store, exposed to the `set_thread_context` tool.
   *  Both null unless `subject_graph_enabled` is on (wired in engine init). */
  subjectStore: SubjectStore | null;
  threadStore: ThreadStore | null;

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
  /**
   * When true, plain-HTTP requests are rejected (HTTPS-only). Localhost is
   * always exempted so dev servers work. Engine-init wires this from
   * `userConfig.enforce_https`.
   */
  enforceHttps: boolean;

  // ── API Store (per-API rate limiting + knowledge) ──
  apiStore: import('./api-store.js').ApiStore | null;

  // ── Artifact Store ──
  artifactStore: import('./artifact-store.js').ArtifactStore | null;

  // ── Isolation (bash tool) ──
  isolationEnvOverride: Record<string, string> | undefined;
  isolationMinimalEnv: boolean;

  // ── Step hint from ask_user (applied at next session.run()) ──
  pendingStepHint: StepHint | null;

  /**
   * Managed credit lifecycle host (the Engine). Lets an in-run tool helper that
   * spends the pool key on a SEPARATE `beta.messages.stream` (web-search rerank,
   * plan_task DAG planning, api_setup docs extraction) debit that marginal cost
   * to the tenant balance — those tokens never flow through the agent's stream,
   * so the run's own `onAfterRun` debit would otherwise miss them. No gate here:
   * the enclosing run is already gated. Null on self-host / BYOK (no hooks).
   */
  meteredHost: HookHost | null;
}

/** Create a default (empty) ToolContext. */
export function createToolContext(userConfig: LynoxUserConfig): ToolContext {
  return {
    dataStore: null,
    crm: null,
    taskManager: null,
    knowledgeLayer: null,
    runHistory: null,
    userConfig,
    subjectStore: null,
    threadStore: null,
    tools: [],
    streamHandler: null,
    networkPolicy: undefined,
    allowedHosts: undefined,
    allowedWildcards: [],
    rateLimitProvider: null,
    hourlyRateLimit: Infinity,
    dailyRateLimit: Infinity,
    enforceHttps: false,
    apiStore: null,
    artifactStore: null,
    isolationEnvOverride: undefined,
    isolationMinimalEnv: false,
    pendingStepHint: null,
    meteredHost: null,
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

/**
 * Enable or disable HTTPS-only enforcement on a ToolContext. Plain HTTP
 * requests to non-localhost hosts will be rejected at validateUrl when
 * enabled. Engine-init wires this from `userConfig.enforce_https`.
 */
export function applyEnforceHttps(ctx: ToolContext, enforce: boolean): void {
  ctx.enforceHttps = enforce;
}
