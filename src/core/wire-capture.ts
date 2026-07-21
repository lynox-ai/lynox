/**
 * Extended debug capture — the provider-agnostic "what the model actually saw".
 *
 * The engine assembles each turn's outbound request in layers; two of them — the
 * ephemeral context tail on the last user message, and the offered tool set — are
 * never persisted, so no export or ledger can show them. Yet they decide behavior
 * (a weak model flips escalate→inline on the injected tail alone). This module
 * captures the fully-assembled request at the Agent's provider-agnostic outbound
 * seam (after `_applyOutboundCaching`, before dispatch) so it can be replayed by the
 * faithful model-fitness eval and (later) bundled into an operator debug export.
 *
 * See pro `docs/internal/prd/extended-debug-capture.md` (Surface B = the dev sink
 * built here; Surface A = the operator settings-gated export, step 2).
 *
 * SDK-type-free by design: callers extract plain strings/arrays, so this module has
 * no Anthropic-SDK dependency and is reusable by the eval's wire-replay consumer.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Short } from './utils.js';

/** One captured outbound request. `userMessage` is REDACTED (see `redactWireUserMessage`). */
export interface WireSnapshot {
  runId: string | undefined;
  turnIndex: number;
  model: string;
  provider: string;
  /** `sha256Short` of the system prompt text — points into `prompt_snapshots` for dedupe.
   *  (Step-2 must confirm the input matches session.ts's `effectivePrompt` exactly.) */
  systemPromptHash: string;
  /** FULL last user message incl. the ephemeral tail — secrets-catalog REDACTED. */
  userMessage: string;
  userMessageChars: number;
  toolNames: string[];
  toolCount: number;
  toolChoice: string | undefined;
  temperature: number | undefined;
  maxTokens: number;
  /** Whether the Agent appended a grounding tail (retrieved_context / memory / briefing) this turn. */
  ephemeralTailPresent: boolean;
  /** Size of the Agent-appended grounding blocks. NOTE: excludes the Session-layer `[Now:]`
   *  prefix / `<secrets>` catalog already baked into the user message (a step-2 refinement). */
  ephemeralTailChars: number;
  capturedAt: number;
}

export interface WireSnapshotInput {
  runId: string | undefined;
  turnIndex: number;
  model: string;
  provider: string;
  systemText: string;
  /** RAW last user message (incl. tail) — redacted inside `buildWireSnapshot`. */
  userMessage: string;
  toolNames: string[];
  toolChoice?: string | undefined;
  temperature?: number | undefined;
  maxTokens: number;
  ephemeralTailChars: number;
}

/**
 * Redact the engine-built `<secrets>…</secrets>` catalog from a captured user message.
 * The block has a fixed engine shape (`<secrets>secret:NAME (***last4), …</secrets>`,
 * built in `engine-init.ts`) — reduce it to a bare count so neither the secret NAMES nor
 * the last-4 mask survive the capture (PRD §4). Whitespace-tolerant, case-insensitive,
 * dot-all; handles multiple blocks. Targeted at the one known engine-built leak — a broad
 * secret-value scan (for an unmasked key pasted into a message/memory) is a step-2 concern.
 */
export function redactWireUserMessage(text: string): string {
  return text.replace(/<\s*secrets\s*>([\s\S]*?)<\s*\/\s*secrets\s*>/gi, (_m, inner: string) => {
    const count = (inner.match(/secret:/gi) ?? []).length;
    const label = count === 1 ? '1 secret' : `${count} secrets`;
    return `<secrets>${label} available (names+last4 redacted)</secrets>`;
  });
}

/** Build a redacted `WireSnapshot` from the assembled outbound-request primitives (pure). */
export function buildWireSnapshot(input: WireSnapshotInput): WireSnapshot {
  const userMessage = redactWireUserMessage(input.userMessage);
  return {
    runId: input.runId,
    turnIndex: input.turnIndex,
    model: input.model,
    provider: input.provider,
    systemPromptHash: sha256Short(input.systemText),
    userMessage,
    userMessageChars: userMessage.length,
    toolNames: input.toolNames,
    toolCount: input.toolNames.length,
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    maxTokens: input.maxTokens,
    ephemeralTailPresent: input.ephemeralTailChars > 0,
    ephemeralTailChars: input.ephemeralTailChars,
    capturedAt: Date.now(),
  };
}

// --- Dev file-sink (Surface B) ------------------------------------------------

const DEFAULT_GATE_FILE = '/tmp/wire-sink-on';
const DEFAULT_SINK_DIR = join(tmpdir(), 'lynox-wire-sink');

/**
 * The dev/eval sink is enabled by a single deliberate on-switch: the runtime FILE-GATE
 * (default `/tmp/wire-sink-on`), matching the original spike. A file-gate — NOT an env var
 * — is the switch precisely so no stray env var can ever silently start writing model
 * context to disk; creating the gate file requires deliberate in-container access. The env
 * var only CUSTOMIZES the destination dir (see `wireSinkDir`); it never enables capture. So
 * enabling on any box is one `touch` (local, staging, or a canary container), no restart.
 * DEV/STAGING path only — the operator capture path (step 2) is a persisted settings toggle.
 */
export function isWireSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const gate = env.LYNOX_DEBUG_WIRE_GATE_FILE ?? DEFAULT_GATE_FILE;
  return existsSync(gate);
}

/** The sink destination dir — `LYNOX_DEBUG_WIRE_SINK` when set, else a default under tmpdir. */
export function wireSinkDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LYNOX_DEBUG_WIRE_SINK ?? DEFAULT_SINK_DIR;
}

/**
 * Best-effort write of a snapshot to the dev sink dir at 0600 (dir created 0700). NEVER
 * throws into the hot path — a sink failure must not affect a real turn.
 */
export function writeWireSnapshot(snapshot: WireSnapshot, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = wireSinkDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeRun = (snapshot.runId ?? 'norun').replace(/[^A-Za-z0-9_-]/g, '_');
    const file = join(dir, `wire-${safeRun}-t${snapshot.turnIndex}-${snapshot.capturedAt}.json`);
    writeFileSync(file, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  } catch {
    // swallow — dev diagnostics must never break a turn
  }
}

/** Convenience: build + write when the sink gate is on. Returns the snapshot, or null if gated off. */
export function captureWireSnapshot(
  input: WireSnapshotInput,
  env: NodeJS.ProcessEnv = process.env,
): WireSnapshot | null {
  if (!isWireSinkEnabled(env)) return null;
  const snapshot = buildWireSnapshot(input);
  writeWireSnapshot(snapshot, env);
  return snapshot;
}
