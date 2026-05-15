/**
 * Canonical hard-limit constants for the lynox engine.
 *
 * SSoT for caps that aren't user-configurable but should be exposed via
 * `/api/config.capabilities.hard_limits` so the UI can render a "System
 * Hard Limits" panel under Cost & Limits (PRD-SETTINGS-REFACTOR).
 *
 * Before this module existed, the same constants lived inline in:
 *   - src/tools/builtin/spawn.ts  (spawn caps + budgets)
 *   - src/tools/builtin/http.ts   (HTTP rate caps)
 *   - src/types/models.ts         (default context window)
 *
 * Call-sites should import from here. The originals re-export from this
 * module for backwards-compat while consumers migrate.
 */

// ── Spawn (sub-agent fan-out) ─────────────────────────────────────────────

/** Default per-spawn cost budget when caller omits `max_budget_usd`. */
export const DEFAULT_SPAWN_BUDGET_USD = 5;

/** Hard cap on caller-supplied `max_budget_usd`. */
export const MAX_SPAWN_BUDGET_USD = 50;

/** Hard cap on caller-supplied `max_turns`. */
export const MAX_SPAWN_TURNS = 50;

/** Default `max_turns` when caller omits it. */
export const DEFAULT_SPAWN_MAX_TURNS = 10;

/** Max agents per single `spawn_agent` invocation (parallel fan-out width). */
export const MAX_SPAWN_AGENTS = 10;

/** Max recursion depth for nested spawns. */
export const MAX_SPAWN_DEPTH = 5;

/** Max length of caller-supplied `name`. */
export const MAX_SPAWN_NAME_LENGTH = 64;

/** Max length of caller-supplied `task`. */
export const MAX_SPAWN_TASK_LENGTH = 16_384;

// ── HTTP-tool rate caps ───────────────────────────────────────────────────

/** Default hourly request cap applied to the `http_request` tool. */
export const HTTP_TOOL_HOURLY_LIMIT = 200;

/** Default daily request cap applied to the `http_request` tool. */
export const HTTP_TOOL_DAILY_LIMIT = 2000;

// ── Context window ────────────────────────────────────────────────────────

/** Fallback context-window size when a model has no `context_window` field. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

// ── API surface for `/api/config.capabilities.hard_limits` ────────────────

/**
 * Shape exposed to the Web UI under `capabilities.hard_limits`.
 *
 * Per PRD-SETTINGS-REFACTOR, managed tiers SHOULD receive an abstract
 * tier-tag instead of these raw numbers; that tier-abstraction lives in
 * `http-api.ts` (caller decides what shape to emit per tier).
 */
export interface HardLimits {
  per_spawn_cents: number;
  max_per_spawn_cents: number;
  spawn_max_turns: number;
  spawn_max_agents_per_call: number;
  spawn_max_depth: number;
  tool_http_per_hour: number;
  tool_http_per_day: number;
  default_context_window_tokens: number;
}

/** Build the `hard_limits` payload for `/api/config.capabilities`. */
export function getHardLimits(): HardLimits {
  return {
    per_spawn_cents: DEFAULT_SPAWN_BUDGET_USD * 100,
    max_per_spawn_cents: MAX_SPAWN_BUDGET_USD * 100,
    spawn_max_turns: MAX_SPAWN_TURNS,
    spawn_max_agents_per_call: MAX_SPAWN_AGENTS,
    spawn_max_depth: MAX_SPAWN_DEPTH,
    tool_http_per_hour: HTTP_TOOL_HOURLY_LIMIT,
    tool_http_per_day: HTTP_TOOL_DAILY_LIMIT,
    default_context_window_tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
  };
}
