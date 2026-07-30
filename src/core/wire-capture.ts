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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256Short } from './utils.js';
import { maskSecretPatterns } from './secret-store.js';

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
 * Redact secrets from a captured user message. Two layers:
 *  1. The engine-built `<secrets>…</secrets>` catalog (fixed shape
 *     `<secrets>secret:NAME (***last4), …</secrets>`, built in `engine-init.ts`) is reduced
 *     to a bare count so neither the secret NAMES nor the last-4 mask survive. Whitespace-
 *     tolerant, case-insensitive, dot-all; handles multiple blocks.
 *  2. Defense in depth: a raw secret-shaped value that survives OUTSIDE the catalog (an API
 *     key pasted into the message, memory blocks, or the KG tail) is masked via the engine's
 *     own scrubber. This covers the KNOWN provider-key formats `maskSecretPatterns` recognizes
 *     — best-effort, not a guarantee for arbitrary high-entropy strings; it closes the
 *     pasted-key leak the catalog reduction alone misses (PRD §4).
 * Owner KG/memory content is deliberately retained (diagnostic signal, owner's own data).
 */
export function redactWireUserMessage(text: string): string {
  const withoutCatalog = text.replace(/<\s*secrets\s*>([\s\S]*?)<\s*\/\s*secrets\s*>/gi, (_m, inner: string) => {
    const count = (inner.match(/secret:/gi) ?? []).length;
    const label = count === 1 ? '1 secret' : `${count} secrets`;
    return `<secrets>${label} available (names+last4 redacted)</secrets>`;
  });
  return maskSecretPatterns(withoutCatalog);
}

/**
 * Extract the snapshot's derived fields from the assembled outbound request — the FULL last
 * user message text (incl. the ephemeral tail), the concatenated system text, and the offered
 * tool names. Pure + structurally typed (SDK-free) so the agent.ts seam mapping is unit-tested
 * rather than only proven by a manual staging smoke.
 */
export function extractWireFields(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
  systemBlocks: ReadonlyArray<{ text: string }>,
  tools: ReadonlyArray<{ name: string }>,
): { userMessage: string; systemText: string; toolNames: string[] } {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  return {
    userMessage: extractMessageText(lastUser?.content),
    systemText: systemBlocks.map(b => b.text).join('\n'),
    toolNames: tools.map(t => t.name),
  };
}

/** Flatten a message's content to text: a string as-is; a block array as its text-block text,
 *  with a `[type]` placeholder for non-text blocks (tool_result, image, …); '' otherwise. */
function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(b => {
      if (b !== null && typeof b === 'object' && 'type' in b) {
        const type = (b as { type: unknown }).type;
        if (type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return `[${String(type)}]`;
      }
      return '';
    })
    .join('\n');
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

/**
 * Both the arming marker and the sink now default under the engine's OWN data dir, not `/tmp`.
 *
 * `/tmp` is world-writable, so the previous default made "is the sink armed?" a question any
 * process on the box — including a tool call steered by injected content — could answer yes to
 * by creating one empty file. The data dir is the same directory that already holds the vault
 * and the databases: a writer who can reach it has the secrets anyway, so the marker stops being
 * the weakest link. (DEF-wire-sink-tmp-arming, DEF-wire-capture-prod-gate leg 2.)
 *
 * ⚠️ This MOVES the arming path. An operator who armed the old `/tmp/wire-sink-on` will find the
 * sink silently off after upgrading — deliberate: for a capture surface, failing closed on an
 * ambiguity is the right direction. `LYNOX_DEBUG_WIRE_GATE_FILE` still overrides it explicitly.
 */
function defaultGateFile(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'wire-sink-on');
}
function defaultSinkDir(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'wire-sink');
}

/** Resolve the data dir the way the rest of the engine does (`config.ts:112-113`). */
function dataDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env['LYNOX_DATA_DIR'] ?? env['LYNOX_DIR'];
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.lynox');
}

/**
 * Env markers that say "the control plane provisioned this container for a customer".
 *
 * All three are emitted on EVERY tier including BYOK/hosted (`contract/env-registry.ts:121`,
 * `:126` — `emitPolicy: 'always'`, `requiredForTier: ALL_TIERS`), which is exactly the scope
 * wanted: a BYOK tenant's box is no more a debugging surface than a managed one.
 * `LYNOX_MANAGED_MODE` is the legacy alias the registry says the engine honours forever.
 */
const PROVISIONED_INSTANCE_MARKERS = [
  'LYNOX_MANAGED_INSTANCE_ID',
  'LYNOX_BILLING_TIER',
  'LYNOX_MANAGED_MODE',
] as const;

/**
 * A capture sink must not arm on a container the control plane provisioned for someone.
 *
 * This is the structural half of the gate, and it is what a file marker cannot be: process env
 * is fixed at exec. An in-container actor — including a tool call steered by injected content —
 * can create a file; it cannot rewrite the environment of the already-running engine. So on a
 * customer instance the answer is no regardless of what exists on disk.
 *
 * Fail-CLOSED on a partial env: ANY marker present is enough. A container carrying only some of
 * them is a provisioning bug, not a licence to capture.
 */
export function isProvisionedInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  return PROVISIONED_INSTANCE_MARKERS.some((k) => (env[k] ?? '').length > 0);
}

/**
 * The operator escape hatch, and it exists for a recorded reason rather than to soften the gate.
 *
 * A blanket refusal on every provisioned instance would break a workflow that is in use: the
 * capture acceptance test — and Workstream 2's wire-replay input — arms the sink on the managed
 * QA tenant `qa-managed` via `staging-tenant-exec`. `DEF-wire-capture-prod-gate` says so in its
 * own source note ("a blanket prod-refuse would break the managed staging capture WS2 needs"),
 * which is why that row was downgraded rather than fixed this way the first time.
 *
 * So the refusal is conditional on something the threat cannot supply. The threat is an
 * in-container actor — a tool call steered by injected content — which can create a file
 * anywhere it can write, but **cannot alter the environment of the already-running engine**.
 * Setting this variable means editing the tenant's env through the control plane and recreating
 * the container: an operator action, deliberate, attributable, and visible in the env preview.
 *
 * That is the whole difference between this and the marker file it guards. Not "env is safer than
 * files" in general — env is a poor secret channel — but here, for THIS threat, env is the one
 * channel the attacker is outside of.
 */
export function provisionedCaptureAcknowledged(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['LYNOX_DEBUG_WIRE_ALLOW_PROVISIONED'] ?? '') === '1';
}

/** Refuse when this is a provisioned instance AND no operator acknowledgement is present. */
function captureRefused(env: NodeJS.ProcessEnv): boolean {
  return isProvisionedInstance(env) && !provisionedCaptureAcknowledged(env);
}

/**
 * The dev/eval sink is armed by a runtime FILE-GATE: a file must exist at the gate path
 * (default `/tmp/wire-sink-on`), matching the original spike. Arming is a deliberate `touch`,
 * not a value flip — but the invariant is the FILE's existence, not "env can't reach it":
 * both the gate path (`LYNOX_DEBUG_WIRE_GATE_FILE`) and the destination dir
 * (`LYNOX_DEBUG_WIRE_SINK`, see `wireSinkDir`) are env-configurable, so the environment
 * participates in arming rather than being unable to. One `touch`, no restart, on a box the
 * OPERATOR controls for debugging (local or a staging container).
 *
 * This is an operator DEBUGGING tool, NOT an auth boundary: the gate file is a convenience, not
 * a permission, so it must NOT be enabled on a customer/production instance — that would write
 * their (secret-scrubbed but still personal) data to disk.
 *
 * That last sentence used to end "until that exists, the boundary here is operator discipline".
 * It no longer is: `isProvisionedInstance` refuses on any control-plane-provisioned container,
 * and process env is not writable by an in-container actor. Discipline is now the fallback for
 * the operator's own boxes, not the only layer on a customer's.
 */
export function isWireSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (captureRefused(env)) return false;
  const gate = env['LYNOX_DEBUG_WIRE_GATE_FILE'] ?? defaultGateFile(env);
  return existsSync(gate);
}

/** The sink destination dir — `LYNOX_DEBUG_WIRE_SINK` when set, else under the data dir. */
export function wireSinkDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['LYNOX_DEBUG_WIRE_SINK'] ?? defaultSinkDir(env);
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

/**
 * Convenience: gate-check + build + write in one call. Returns the snapshot, or null if
 * gated off. The single-sink dev/eval entry point — the Agent seam does NOT use it (it
 * inlines `buildWireSnapshot` + `writeWireSnapshot` so ONE build fans out to both the dev
 * file-sink AND the operator `onWireSnapshot` callback without redacting/building twice);
 * this stays the standalone one-shot for callers that only need the file sink.
 */
export function captureWireSnapshot(
  input: WireSnapshotInput,
  env: NodeJS.ProcessEnv = process.env,
): WireSnapshot | null {
  if (!isWireSinkEnabled(env)) return null;
  const snapshot = buildWireSnapshot(input);
  writeWireSnapshot(snapshot, env);
  return snapshot;
}

// --- Raw body sink (eval / wire-replay path) ----------------------------------

function defaultRawGateFile(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'wire-sink-raw-on');
}
function defaultRawSinkDir(env: NodeJS.ProcessEnv): string {
  return join(dataDir(env), 'wire-sink-raw');
}

/**
 * The FULL, UNREDACTED agent-level assembled request — the faithful, replayable representation
 * of what the model saw, captured BEFORE the provider client translates it to the Anthropic /
 * openai wire. The redacted `WireSnapshot` is for the operator diagnostic path; this is the
 * eval path: the model-fitness wire-replay re-sends this exact request to each candidate model
 * (through that candidate's own client), so the provider-specific translation stays faithful.
 *
 * ⚠️ Contains the FULL secrets catalog (names + last-4), memory blocks, and KG — it is NOT
 * redacted (redacting would defeat replay fidelity). Therefore it is DEV/STAGING-EVAL ONLY, on
 * the owner's OWN instance, behind a SEPARATE, more deliberate gate (`/tmp/wire-sink-raw-on`) —
 * never the operator export, never a customer/production instance.
 */
export interface RawWireBody {
  runId: string | undefined;
  turnIndex: number;
  model: string;
  provider: string;
  /** The assembled system blocks, outbound messages, and offered tools — verbatim (unredacted). */
  system: unknown;
  messages: unknown;
  tools: unknown;
  maxTokens: number;
  capturedAt: number;
}

/** Raw-body capture is enabled ONLY by its OWN file-gate (distinct from the redacted sink), so
 *  the more-sensitive unredacted dump is a separate, deliberate opt-in — and, like the redacted
 *  sink, it refuses outright on a provisioned instance. This one matters more: the redacted sink
 *  writes scrubbed personal data, this one writes the full secrets catalog and the whole KG. */
export function isRawWireSinkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (captureRefused(env)) return false;
  const gate = env['LYNOX_DEBUG_WIRE_RAW_GATE_FILE'] ?? defaultRawGateFile(env);
  return existsSync(gate);
}

/** The raw-body sink dir — `LYNOX_DEBUG_WIRE_RAW_SINK` when set, else under the data dir. */
export function rawWireSinkDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['LYNOX_DEBUG_WIRE_RAW_SINK'] ?? defaultRawSinkDir(env);
}

/** Best-effort 0600 write of the raw body. NEVER throws into the hot path. */
export function writeRawWireBody(body: RawWireBody, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const dir = rawWireSinkDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeRun = (body.runId ?? 'norun').replace(/[^A-Za-z0-9_-]/g, '_');
    const file = join(dir, `raw-${safeRun}-t${body.turnIndex}-${body.capturedAt}.json`);
    writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  } catch {
    // swallow — eval diagnostics must never break a turn
  }
}

/** Convenience: write the raw body when its gate is on. Returns the body, or null if gated off. */
export function captureRawWireBody(
  body: Omit<RawWireBody, 'capturedAt'> & { capturedAt?: number },
  env: NodeJS.ProcessEnv = process.env,
): RawWireBody | null {
  if (!isRawWireSinkEnabled(env)) return null;
  const full: RawWireBody = { ...body, capturedAt: body.capturedAt ?? Date.now() };
  writeRawWireBody(full, env);
  return full;
}
