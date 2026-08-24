// === 4.2 Tool Contract ===

import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

import type { IAgent } from './agent.js';
import type { AutonomyLevel, CostSnapshot } from './modes.js';
import type { ModelTier } from './models.js';
import type { UntrustedCause } from '../core/untrusted-signals.js';

export type ToolHandler<TInput = unknown> =
  (input: TInput, agent: IAgent) => Promise<string>;

/**
 * Structured payload a tool's `destructive.check` may return INSTEAD of a plain
 * action-label string, when the consent gate carries information beyond "this
 * mutates data". The spawn-agent deep-tier consent gate is the first user: it
 * names the tier, the estimated cost, and the provider a deep delegation would
 * run on, so the user can make an informed call before authorising expensive work.
 *
 * The permission guard renders `message` as the GO text verbatim (it IS the whole
 * warning, not a suffix); the structured fields let a UI render a richer card and,
 * when `downgradeTo` is set, offer a cheaper alternative.
 *
 * `provenance` is OPTIONAL and only set where the engine can PROVE the data path
 * (e.g. a control-plane provider registry naming the processing region). It is
 * deliberately left undefined in the public engine rather than guessed — a wrong
 * region claim is worse than none.
 */
export interface WarningPayload {
  message: string;
  tier?: ModelTier | undefined;
  costUsd?: number | undefined;
  provider?: string | undefined;
  provenance?: string | undefined;
  /**
   * Present => the GO may offer to run on this cheaper tier instead. Reserved for
   * the spawn-consent deny→balanced path (PR2b): the deep-tier check (PR2a) does
   * not set it yet, so today no producer populates this field by design.
   */
  downgradeTo?: 'balanced' | undefined;
}

export interface ToolEntry<TInput = unknown> {
  definition: BetaTool;
  handler:    ToolHandler<TInput>;
  /**
   * When true, the tool handles its own user confirmation via
   * agent.promptUser() — the Permission Guard skips the generic warning
   * in interactive mode but still BLOCKS in autonomous mode.
   *
   * Use this for tools that show a meaningful preview to the user
   * (e.g. mail_send shows To/Subject/Body) instead of the guard's
   * generic "sends external mail" warning.
   */
  requiresConfirmation?: boolean | undefined;
  /**
   * Optional redactor for the tool input before it is captured in the
   * audit trail (channels.toolEnd → run_tool_calls.input_json). Tools
   * that handle sensitive payloads (e.g. mail bodies) return an
   * audit-safe shape with the sensitive fields removed/replaced.
   * Returning the input unchanged is equivalent to omitting the hook.
   */
  redactInputForAudit?: ((input: TInput) => unknown) | undefined;
  /**
   * Declares this tool as destructive. The Permission Guard warns in
   * interactive mode and BLOCKS in autonomous mode based on this flag.
   *
   * - `mode: 'data'`     → "destroys stored data" (e.g. data_store_drop)
   * - `mode: 'external'` → "modifies external data" (e.g. google_calendar create_event)
   *
   * For action-discriminated tools (e.g. google_drive: only "upload"/"share"
   * are destructive, "search"/"read" are safe), provide `check`. It returns
   * the action label for destructive inputs, or `null` for safe ones. Omit
   * `check` for always-destructive tools.
   *
   * `check` may instead return a {@link WarningPayload} — used when the gate
   * carries richer information than an action label (the spawn-agent deep-tier
   * consent gate names tier + cost + provider). The guard renders the payload's
   * `message` verbatim. The optional second argument `ctx` carries the run's
   * `autonomy`, so a check can opt OUT of gating in autonomous mode (spawn does:
   * the handler clamps deep→balanced headlessly instead of refusing).
   *
   * Colocating this with the tool registration keeps the write-action
   * set next to the input schema — adding a new write action no longer
   * requires updating a separate enumerated list in the guard.
   */
  destructive?: {
    mode: 'data' | 'external';
    check?: (input: TInput, ctx?: { autonomy?: AutonomyLevel | undefined }) => string | WarningPayload | null;
  } | undefined;
  /**
   * When true, calling this tool ENDS the agent's turn: after the tool_result
   * is appended and checkpointed, the loop returns the turn's text instead of
   * looping back to the model. Use for terminal tools whose whole job is a
   * final side effect with nothing more to say (e.g. `suggest_follow_ups`,
   * which emits end-of-turn suggestion chips) — this skips the extra
   * full-context round-trip a regular tool would force before `end_turn`.
   */
  endsTurn?: boolean | undefined;
  /**
   * Extended usage guidance loaded ON FIRST USE instead of shipping in the
   * always-cached tool `description`. Keep the selection-critical "what it does /
   * when to use / core actions" in `definition.description` (the model needs that
   * to pick + call the tool the first time); move the fat narrative — recovery
   * rules, anti-patterns, post-first-call flow — here.
   *
   * It is NOT part of `definition`, so it never reaches the wire tool schema and
   * never enters the cached prompt prefix. The agent loop injects it once per
   * thread, the first time this tool is called (success OR error), as a
   * model-only carrier text block AFTER the cache breakpoint — cache-safe, and
   * suppressed from the chat UI (see `TOOL_GUIDANCE_MARKER`). Provider-agnostic:
   * it rides the same tool-result carrier on Anthropic and the OpenAI-compatible
   * (Mistral) path. This is the classifier-free interim prefix reducer that
   * stacks with a later tool-availability classifier.
   */
  detailedGuidance?: string | undefined;
}

// === 4.3 Stream Event Union ===

import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
export type { BetaUsage as Usage };

/**
 * One delegated child in a `spawn_agent` batch, as announced to the UI.
 *
 * `id` is what every later event keys on, and it exists because `name` cannot
 * carry that load: the name is model-chosen and the engine enforces only length
 * and control-character limits (`validateSpawnInput`), so one batch may well
 * hold two children called "researcher". Keying on the name merges their
 * activity into one row; keying on `id` keeps them apart. `name` stays purely
 * a display label.
 */
export interface SpawnedSubAgent {
  /** Stable within the run: `<spawnId>:<index>`. Unique by construction. */
  id: string;
  /** Model-chosen label. Display only — NOT unique within a batch. */
  name: string;
  /** Built-in role id, when the spawn requested one. */
  role?: string | undefined;
  /** Concrete model this child runs on (sanitized id, not the tier). */
  model?: string | undefined;
  /** Resolved capability tier this child runs on (fast/balanced/deep). Lets the
   * spawn panel show what was actually delegated to, separately from the model id. */
  tier?: ModelTier | undefined;
  /**
   * Set when this child was clamped down from deep to balanced because the user
   * chose "Run on balanced" at the consent gate. Lets the result + spawn panel
   * label the run honestly (predicate 5: "ran on balanced — you declined deep;
   * quality may be lower") instead of presenting a silent downgrade.
   */
  downgraded?: boolean | undefined;
}

export type StreamEvent =
  | { type: 'text';        text: string;                           agent: string; subAgent?: string | undefined }
  | { type: 'thinking';    thinking: string;                       agent: string; subAgent?: string | undefined }
  | { type: 'thinking_done';                                       agent: string; subAgent?: string | undefined }
  | { type: 'tool_call';   name: string; input: unknown;           agent: string; subAgent?: string | undefined; subAgentId?: string | undefined }
  | { type: 'tool_progress'; tool: string; phase: string;          agent: string; subAgent?: string | undefined }
  | { type: 'api_cost'; tool: string; profileId: string; profileName: string;
      endpoint: string; costUsd: number;                           agent: string; subAgent?: string | undefined }
  | { type: 'tool_result'; name: string; result: string;           agent: string; isError?: boolean; subAgent?: string | undefined; subAgentId?: string | undefined }
  | { type: 'spawn';       spawnId: string; subAgents: SpawnedSubAgent[];
      estimatedCostUSD?: number | undefined;                       agent: string }
  // 5s heartbeat for a running batch. `running` and the keys of `lastToolBySub`
  // are `SpawnedSubAgent.id`s, not names — see the note on that interface.
  | { type: 'spawn_progress'; spawnId: string; elapsedS: number; running: string[];
      lastToolBySub: Record<string, string>; agent: string }
  // `costUsd` is the child's OWN actual spend (its cost snapshot), reported
  // whether it finished, failed, or was aborted — a child that died halfway
  // still spent what it spent. It is already counted in the turn's aggregate;
  // this breaks that aggregate down to where the money went.
  | { type: 'spawn_child_done'; spawnId: string; subAgent: string; subAgentId: string;
      ok: boolean; elapsedS: number; costUsd: number;              agent: string }
  | { type: 'turn_end';    stop_reason: string; usage: BetaUsage;  model?: string | undefined; contextWindow?: number | undefined; agent: string }
  // `fatal` is REQUIRED, and that is the whole point: the compiler now forces
  // every emitter to say whether the turn is over. Before this field the channel
  // carried both `the run is dead` (agent.ts, iteration limit) and `something
  // went wrong and I am continuing` (stream.ts, unparsable tool input) under one
  // name, so no receiver could tell them apart — the client marked a live,
  // billing run as `not sent — tap to retry`. Adding an OPTIONAL flag would have
  // left the next emitter free to skip the decision and reopen the same hole.
  | { type: 'error';       message: string; fatal: boolean;         agent: string }
  | { type: 'warning';     code: string; detail?: string | undefined; agent: string }
  | { type: 'retry';       attempt: number; maxAttempts: number; delayMs: number; reason: string; agent: string }
  | { type: 'cost_warning';  snapshot: CostSnapshot;               agent: string }
  | { type: 'continuation';  iteration: number; max: number;       agent: string }

  | { type: 'pipeline_start'; pipelineId: string; name: string;
      steps: Array<{ id: string; task: string; inputFrom?: string[] | undefined }>; agent: string }
  | { type: 'pipeline_progress'; stepId: string; status: 'started' | 'completed' | 'skipped' | 'failed';
      detail?: string | undefined; durationMs?: number | undefined; elapsed?: number | undefined;
      summary?: string | undefined; agent: string }
  | { type: 'context_pressure'; droppedMessages: number; usagePercent: number; agent: string }
  | { type: 'context_budget'; systemTokens?: number; toolTokens?: number; messageTokens?: number;
      totalTokens: number; maxTokens: number; usagePercent: number;
      // Cost-aware budget occupancy (Session._compactionUsagePercent — the SAME
      // figure that drives `_autoCompactIfNeeded`'s offer/auto-compact triggers),
      // injected by Session's stream wrapper alongside the honest window-fill
      // `usagePercent` above. Distinct on purpose: on a large native window a
      // thread can carry cost past the compaction budget long before the real
      // window fills, so a consumer that wants a cost signal (not just window
      // fill) reads this field instead of re-deriving it from totalTokens/maxTokens.
      budgetPercent?: number | undefined; agent: string }
  | { type: 'changeset_ready'; fileCount: number; agent: string }
  | { type: 'context_compacted'; summary: string; previousUsagePercent: number; agent: string }
  | { type: 'compaction_offer'; usagePercent: number; agent: string }

  // DK-UX: a durable-knowledge write happened this turn. A CLIENT-ONLY signal for the
  // inline chip (trusted → "gemerkt in X · undo", untrusted → review "keep/discard").
  // NOT a tool-result and never folded into model context — it renders in the web-ui from
  // the SSE side-channel only. `text` carries the raw (possibly-injected) wording for the
  // untrusted review chip; that is exactly why it stays strictly client-bound.
  // `cause` says WHY a write was routed to review, in the engine's own vocabulary
  // (`describeTurnUntrusted`). Only meaningful for `pending_review`. Without it the chip can
  // only say "from external content", which is true of every queued write and therefore tells
  // the person nothing they can judge — and a confirmation nobody can judge is a reflex, which
  // is worse than no gate because it looks like a control.
  | { type: 'knowledge_write'; id: string; subject?: string | undefined; kind?: string | undefined;
      status: 'active' | 'pending_review'; text: string; agent: string;
      cause?: UntrustedCause | undefined };

export type StreamHandler = (event: StreamEvent) => void | Promise<void>;

/**
 * One end-of-turn follow-up chip, as the `suggest_follow_ups` tool takes it and
 * the Web UI renders it.
 *
 * Note the asymmetry the UI applies: it DISPLAYS `label` and SENDS `task` — the
 * task text is never shown to the user before it runs as a full agent turn.
 * Anything producing suggestions must treat `task` as the security-relevant
 * field, not `label`.
 */
export interface FollowUpSuggestion {
  /** Chip text. Short — see FOLLOW_UP_MAX_LABEL_CHARS. */
  label: string;
  /** Self-contained instruction executed when the chip is clicked. */
  task: string;
}

// === 4.3b Run Event (serializable event log for async poll) ===

export interface RunEvent {
  id: number;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text_chunk' | 'turn_end' | 'error' | 'continuation';
  timestamp: number;
  data: Record<string, unknown>;
}
