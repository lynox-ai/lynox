import { randomUUID } from 'node:crypto';
import { getBetasForProvider, getModelId } from '../types/index.js';
import { createLLMClient, getActiveProvider } from './llm-client.js';
import type { LLMProvider, ProcessRecord, ProcessStep, ProcessParameter } from '../types/index.js';
import type { ToolCallRecord } from './run-history.js';

/** Tools that are internal bookkeeping — excluded from process capture */
const INTERNAL_TOOLS = new Set([
  'memory_store', 'memory_recall', 'memory_delete', 'memory_update', 'memory_list', 'memory_promote',
  'ask_user', 'plan_task', 'save_workflow',
]);

const MAX_INPUT_CHARS = 500;
const MAX_OUTPUT_CHARS = 200;

// Safety pre-cap applied BEFORE redaction so a pathologically large tool
// output cannot make the regex scan unbounded. Generously sized (50x the
// final output cap) so any secret near the real truncation boundary is still
// well inside the redaction window — redact-then-truncate is preserved.
const MAX_REDACTION_SCAN_CHARS = 10_000;

const REDACTED = '[REDACTED]';

interface CaptureOptions {
  apiKey: string;
  apiBaseURL?: string | undefined;
  description?: string | undefined;
  /**
   * LLM provider for the Haiku-tier annotation call. Defaults to the
   * process-wide active provider (`getActiveProvider()`). Plumb the
   * caller's actual provider here so a Mistral/OpenAI-compat user's
   * workflow-save call routes to the right endpoint with the right
   * model id — without this, `getModelId('fast', 'anthropic')` returns
   * `claude-haiku-…` which Mistral rejects with 4xx.
   */
  provider?: LLMProvider | undefined;
  /** Model ID for OpenAI-compatible providers (e.g. 'ministral-8b-2512'). */
  openaiModelId?: string | undefined;
  /** Auth mode for 'openai' provider. Default 'static'. */
  openaiAuth?: 'static' | 'google-vertex' | undefined;
}

/**
 * Value-pattern secret scanners. Key-name redaction alone misses bearer
 * tokens, OAuth refresh tokens, JWTs and provider tokens that arrive as
 * bare values inside tool inputs/outputs. These regexes redact the secret
 * value wherever it appears.
 */
const VALUE_SECRET_PATTERNS: RegExp[] = [
  // Bearer / token auth headers — `Bearer <token>`, `token <token>`.
  /\b(Bearer|token)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi,
  // Slack-style tokens — xoxb-, xoxp-, xapp-, xoxa-, xoxr- …
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/gi,
  // JWT shape — three base64url segments separated by dots.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Common provider key prefixes (Anthropic, OpenAI, GitHub, Stripe, Google).
  /\b(sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|rk_live_|sk_live_|sk_test_|AIza)[A-Za-z0-9\-_]{12,}/g,
];

/**
 * High-entropy bare string detector — catches long random-looking tokens
 * (API keys, session secrets) that carry no recognizable prefix. Applied to
 * whitespace/quote-delimited "words" so ordinary prose is not mangled.
 */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksHighEntropy(token: string): boolean {
  // Long, mixed-charset, and high per-character entropy = likely a secret.
  // 24-char floor is a deliberate gap: shorter secrets (e.g. 16-char keys)
  // are not entropy-redacted — lowering it risks mangling legitimate IDs and
  // hashes in prose. Prefixed/known-shape short secrets are still caught by
  // the value-pattern scan above.
  if (token.length < 24) return false;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  // Require alphanumeric mix; URLs/sentences fail this.
  if (!((hasUpper || hasLower) && hasDigit)) return false;
  // Reject anything with spaces — already split into words upstream.
  return shannonEntropy(token) >= 3.6;
}

/**
 * Redact secrets from a serialized tool-call field. Runs key-name redaction,
 * value-pattern scanning, and high-entropy detection. Must run BEFORE any
 * length truncation so a secret split across the truncation boundary cannot
 * evade detection (redact-then-truncate, see PRD §6.2).
 */
function redactSecrets(text: string): string {
  // Safety pre-cap so the scan stays bounded on huge tool outputs. Far larger
  // than the final truncation cap, so redact-then-truncate still holds.
  const scoped = text.length > MAX_REDACTION_SCAN_CHARS
    ? text.slice(0, MAX_REDACTION_SCAN_CHARS)
    : text;
  // 1. Key-name redaction — `"api_key": "..."` style JSON pairs. The
  //    `[a-z0-9_-]*` prefix catches namespaced keys whose name ENDS in a
  //    sensitive keyword (`db-password`, `csrf_token`, `x_api_key`), not just
  //    the bare keyword. A keyword buried mid-name is intentionally not matched
  //    — a trailing wildcard would redact innocuous fields like `token_count`.
  let redacted = scoped.replace(
    /"([a-z0-9_-]*(?:api_?key|token|secret|password|authorization|access_token|refresh_token|client_secret))":\s*"[^"]*"/gi,
    '"$1": "[REDACTED]"',
  );
  // 1b. URL-embedded credentials — redact the `user:pass@` userinfo.
  redacted = redacted.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/:@]+@/gi,
    '$1[REDACTED]@',
  );
  // 2. Value-pattern scanning — bearer tokens, xox…, JWT, provider prefixes.
  for (const pattern of VALUE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  // 3. High-entropy bare strings — split on quotes/whitespace + `=;&` so a
  //    secret in `cookie=…;k=…` style runs is isolated, then redact each
  //    token that looks like a random secret.
  redacted = redacted.replace(/[^\s"'`,=;&]{24,}/g, match =>
    looksHighEntropy(match) ? REDACTED : match,
  );
  return redacted;
}

/**
 * Sanitize tool call for LLM consumption — redact secrets, then truncate.
 * Ordering is load-bearing: redaction runs on the full string before the
 * length cap so truncation cannot bisect a secret out of detection range.
 */
function sanitizeToolCall(tc: ToolCallRecord): { tool: string; input: string; output: string; order: number } {
  let input = redactSecrets(tc.input_json);
  if (input.length > MAX_INPUT_CHARS) input = input.slice(0, MAX_INPUT_CHARS) + '...';

  let output = redactSecrets(tc.output_json);
  if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS) + '...';

  return { tool: tc.tool_name, input, output, order: tc.sequence_order };
}

/**
 * One annotation entry the Haiku call returns for a canonical call index.
 * The model annotates a FIXED step list — it never chooses the step set.
 */
export interface StepAnnotation {
  /** Index into the provided canonicalCalls list this annotation describes. */
  index: number;
  description: string;
  inputTemplate: Record<string, unknown>;
  dependsOn?: number[] | undefined;
}

const EXTRACTION_SYSTEM = `You are a process analyst. You are given a FIXED, numbered list of tool calls from a completed task. Each entry has an "index". This list IS the step list of the reusable workflow — it is already decided.

Your ONLY job is to ANNOTATE each numbered entry. You must return exactly one annotation per index that is present in the input list — no more, no fewer. Do NOT merge entries, do NOT skip entries, do NOT reorder them, do NOT invent new entries. The "index" you return must match an index from the provided list.

For each numbered call, provide:
1. "index": the index of the call you are annotating (copied verbatim from the input)
2. "description": a plain-language description of what this step does (for a business user, not a developer). For any value that is one of the workflow parameters below, write a {{params.<name>}} placeholder INSTEAD of the literal value (e.g. "audit {{params.client}}'s spend", NOT "audit Acme Corp's spend").
3. "inputTemplate": a JSON object capturing the call's input values, with parameter values written as {{params.<name>}} placeholders
4. "dependsOn": the indexes of earlier calls whose output this call depends on (an array, possibly empty)

Also identify the workflow's parameters — input values likely to CHANGE between runs. For each, give an "exampleValue": the concrete value EXACTLY as it appeared in THIS run (used only to verify the placeholders, never stored). Classify each as:
- "user_input": value the user provides each time (e.g., client name, specific query)
- "relative_date": time-based value that should be relative (e.g., "last month" not "March 2026")
- "context": value from the environment or previous step output

Return a JSON object with this exact structure:
{
  "steps": [{ "index": 0, "description": "audit {{params.client}}", "inputTemplate": {}, "dependsOn": [] }],
  "parameters": [{ "name": "param_name", "description": "what this is", "type": "string|number|date", "defaultValue": null, "exampleValue": "the value from this run", "source": "user_input|relative_date|context" }]
}`;

const EXTRACT_TOOL = {
  name: 'extract_process',
  description: 'Annotate each numbered tool call in the provided fixed list and identify workflow parameters.',
  input_schema: {
    type: 'object' as const,
    properties: {
      steps: {
        type: 'array' as const,
        description: 'One annotation per index from the provided call list. Exactly one entry per index — no merging, skipping, or reordering.',
        items: {
          type: 'object' as const,
          properties: {
            index: { type: 'number' as const },
            description: { type: 'string' as const },
            inputTemplate: { type: 'object' as const },
            dependsOn: { type: 'array' as const, items: { type: 'number' as const } },
          },
          required: ['index', 'description', 'inputTemplate'],
        },
      },
      parameters: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            name: { type: 'string' as const },
            description: { type: 'string' as const },
            type: { type: 'string' as const, enum: ['string', 'number', 'date'] },
            defaultValue: {},
            exampleValue: { type: 'string' as const },
            source: { type: 'string' as const, enum: ['user_input', 'relative_date', 'context'] },
          },
          required: ['name', 'description', 'type', 'source'],
        },
      },
    },
    required: ['steps', 'parameters'],
  },
};

/**
 * Collapse ONLY literally-identical *consecutive* tool calls — same
 * `tool_name` AND same `input_json` — into one. This models a retried
 * identical call. It is fully deterministic (no LLM) and never merges calls
 * that differ in any way or are non-consecutive.
 *
 * The result IS the step spine: every entry becomes exactly one ProcessStep.
 */
export function collapseConsecutiveDuplicates(actionCalls: ToolCallRecord[]): ToolCallRecord[] {
  const canonical: ToolCallRecord[] = [];
  for (const call of actionCalls) {
    const prev = canonical[canonical.length - 1];
    if (prev && prev.tool_name === call.tool_name && prev.input_json === call.input_json) {
      // Identical consecutive call — a retry. Skip; the spine already has it.
      continue;
    }
    canonical.push(call);
  }
  return canonical;
}

/**
 * Narrow an unknown value from the LLM tool call into a StepAnnotation.
 * Anything that is not shaped like an annotation (or carries a non-numeric
 * index) is rejected — the caller falls back to a synthesized step.
 */
function asStepAnnotation(value: unknown): StepAnnotation | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.index !== 'number' || !Number.isInteger(obj.index)) return null;
  const description = typeof obj.description === 'string' ? obj.description : '';
  const inputTemplate =
    typeof obj.inputTemplate === 'object' && obj.inputTemplate !== null && !Array.isArray(obj.inputTemplate)
      ? (obj.inputTemplate as Record<string, unknown>)
      : {};
  const dependsOn = Array.isArray(obj.dependsOn)
    ? obj.dependsOn.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0)
    : undefined;
  return { index: obj.index, description, inputTemplate, dependsOn };
}

const PARAM_TYPES = new Set<string>(['string', 'number', 'date']);
const PARAM_SOURCES = new Set<string>(['user_input', 'relative_date', 'context']);

/**
 * Narrow an unknown value from the LLM tool call into a ProcessParameter.
 * Mirrors `asStepAnnotation` — an entry with a missing name or an unknown
 * type/source is rejected so a malformed parameter cannot reach
 * `ProcessRecord.parameters` and the downstream param-hint logic.
 */
/** A captured parameter plus its transient example value — used by the
 *  capture-time guard, NEVER persisted on the ProcessRecord. */
interface CapturedParam {
  param: ProcessParameter;
  exampleValue?: string;
}

function asCapturedParam(value: unknown): CapturedParam | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0) return null;
  if (typeof obj.type !== 'string' || !PARAM_TYPES.has(obj.type)) return null;
  if (typeof obj.source !== 'string' || !PARAM_SOURCES.has(obj.source)) return null;
  const param: ProcessParameter = {
    name: obj.name,
    description: typeof obj.description === 'string' ? obj.description : '',
    type: obj.type as 'string' | 'number' | 'date',
    source: obj.source as 'user_input' | 'relative_date' | 'context',
  };
  if (obj.defaultValue !== undefined) param.defaultValue = obj.defaultValue;
  const exampleValue = typeof obj.exampleValue === 'string' && obj.exampleValue.length > 0
    ? obj.exampleValue
    : undefined;
  return exampleValue !== undefined ? { param, exampleValue } : { param };
}

/** Min length of an example value we will auto-substitute on a single-occurrence
 *  leak — shorter values (e.g. "EU", "06") risk matching unrelated text, so they
 *  flag `needsReview` instead. */
const MIN_AUTOSUB_LEN = 4;

/**
 * Capture-time guard (deterministic): catch any parameter value that LEAKED
 * into a step description because the model failed to templatise it. Runs at
 * capture, where the example values are transiently available — the values are
 * NEVER persisted.
 *
 * - value absent from the description → model templatised it (happy path) or the
 *   step doesn't use it → no-op.
 * - exactly one occurrence AND length >= MIN_AUTOSUB_LEN → deterministically
 *   replace it with the `{{params.<name>}}` placeholder.
 * - multiple occurrences, or a value too short to match safely → flag the record
 *   `needsReview` (no risky auto-substitution).
 */
/** Indices of every word-delimited occurrence of `value` in `text` (a match not
 *  flanked by word characters — so "Corp" inside "Corporation" is excluded). */
function wordDelimitedOccurrences(text: string, value: string): number[] {
  const idxs: number[] = [];
  for (let from = 0; ; ) {
    const i = text.indexOf(value, from);
    if (i === -1) break;
    const before = i > 0 ? text[i - 1]! : '';
    const after = text[i + value.length] ?? '';
    if (!/\w/.test(before) && !/\w/.test(after)) idxs.push(i);
    from = i + value.length;
  }
  return idxs;
}

export function applyCaptureGuard(
  steps: ProcessStep[],
  captured: CapturedParam[],
): { steps: ProcessStep[]; needsReview: boolean } {
  let needsReview = false;
  const guarded = steps.map(step => {
    const original = step.description;
    // Collect substitution spans against the ORIGINAL description (never the
    // mutating copy) so an inserted `{{params.…}}` token can't self-match a
    // later parameter value.
    const spans: Array<{ start: number; end: number; name: string }> = [];
    for (const { param, exampleValue } of captured) {
      if (exampleValue === undefined) continue;
      const total = original.split(exampleValue).length - 1;
      if (total === 0) continue;
      const hits = exampleValue.length >= MIN_AUTOSUB_LEN
        ? wordDelimitedOccurrences(original, exampleValue)
        : [];
      // Anything we can't cleanly remove (too short, sub-token, a leftover
      // occurrence) means a literal value may persist → flag for human review.
      // Multiple matches are replaced too, but still flagged so a human verifies.
      if (hits.length !== total || exampleValue.length < MIN_AUTOSUB_LEN || hits.length > 1) {
        needsReview = true;
      }
      for (const start of hits) spans.push({ start, end: start + exampleValue.length, name: param.name });
    }
    if (spans.length === 0) return step;
    // Drop overlapping spans (one value's match sits inside another's) → review.
    spans.sort((a, b) => a.start - b.start);
    const safe: typeof spans = [];
    for (const span of spans) {
      const prev = safe[safe.length - 1];
      if (prev && span.start < prev.end) { needsReview = true; continue; }
      safe.push(span);
    }
    if (safe.length === 0) return step;
    // Apply right-to-left so earlier indices stay valid.
    let description = original;
    for (const span of [...safe].reverse()) {
      description = description.slice(0, span.start) + `{{params.${span.name}}}` + description.slice(span.end);
    }
    return { ...step, description };
  });
  return { steps: guarded, needsReview };
}

/**
 * Build the final, deterministic `ProcessStep[]` from the FIXED canonical call
 * list plus the LLM's annotations. `canonicalCalls` is the step spine: the
 * returned array length ALWAYS equals `canonicalCalls.length` — one step per
 * call, in order. The LLM may only supply description/inputTemplate/dependsOn;
 * it can never add, drop, merge, or reorder a step.
 *
 * For each index `i`:
 *  - `tool` and `order` come from the canonical call (`tool_name`, `i`).
 *  - description/inputTemplate/dependsOn come from the annotation whose
 *    `index === i`. If none matches (LLM omitted it, or returned a duplicate /
 *    out-of-range index), a fallback is synthesized so no call is ever dropped.
 */
export function buildCanonicalSteps(
  canonicalCalls: ToolCallRecord[],
  annotations: StepAnnotation[],
): ProcessStep[] {
  // Index annotations by their `index`. First wins on duplicates so an extra
  // colliding entry from the LLM cannot overwrite a legitimate annotation.
  const byIndex = new Map<number, StepAnnotation>();
  for (const ann of annotations) {
    if (!byIndex.has(ann.index)) byIndex.set(ann.index, ann);
  }

  return canonicalCalls.map((call, i) => {
    const ann = byIndex.get(i);
    if (ann) {
      return {
        order: i,
        tool: call.tool_name,
        description: ann.description || call.tool_name,
        inputTemplate: ann.inputTemplate,
        dependsOn: ann.dependsOn ?? [],
      };
    }
    // Fallback — annotation missing for this index. NEVER drop the call.
    return {
      order: i,
      tool: call.tool_name,
      description: call.tool_name,
      inputTemplate: {},
      dependsOn: [],
    };
  });
}

/**
 * Capture a process from run history tool calls.
 *
 * The step SET is deterministic: internal-tool filter → consecutive-duplicate
 * collapse produces a fixed canonical call list. A lightweight Haiku call only
 * ANNOTATES that fixed list (descriptions, input templates, dependencies) and
 * identifies parameters — it can never choose, merge, skip, or reorder steps.
 * The returned `steps.length` always equals the canonical call count.
 */
export async function captureProcess(
  runId: string,
  name: string,
  toolCalls: ToolCallRecord[],
  options: CaptureOptions,
): Promise<ProcessRecord> {
  // Filter out internal tools
  const actionCalls = toolCalls.filter(tc => !INTERNAL_TOOLS.has(tc.tool_name));

  if (actionCalls.length === 0) {
    return {
      id: randomUUID(),
      name,
      description: options.description ?? '',
      sourceRunId: runId,
      steps: [],
      parameters: [],
      createdAt: new Date().toISOString(),
    };
  }

  // Deterministic step spine — collapse only literally-identical consecutive
  // calls (retries). This fixed list is what the LLM must annotate 1:1.
  const canonicalCalls = collapseConsecutiveDuplicates(actionCalls);

  // Sanitize for LLM consumption, attaching a stable `index` so the model
  // annotates a numbered, fixed list rather than choosing the step set.
  const sanitized = canonicalCalls.map((tc, index) => ({
    index,
    ...sanitizeToolCall(tc),
  }));

  // Call Haiku for step annotation + parameter identification. The caller's
  // provider drives BOTH the client construction AND the tier→model lookup —
  // without that pairing, a Mistral user's workflow-save would build an
  // OpenAIAdapter pointing at api.mistral.ai but try to send a `claude-haiku-…`
  // model id, which Mistral rejects with 4xx. Fall back to the process-wide
  // active provider so legacy callers that don't pass `provider` still work.
  const provider: LLMProvider = options.provider ?? getActiveProvider();
  const isOpenAICompat = provider === 'custom' || provider === 'openai';
  const client = createLLMClient({
    provider,
    apiKey: options.apiKey,
    apiBaseURL: options.apiBaseURL,
    openaiModelId: options.openaiModelId,
    openaiAuth: options.openaiAuth,
  });
  const response = await client.beta.messages.create({
    model: getModelId('fast', provider),
    max_tokens: 4096,
    ...(isOpenAICompat ? {} : { betas: getBetasForProvider(provider) }),
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Task name: "${name}"\n\nFixed numbered tool call list (annotate every index, exactly one entry per index):\n${JSON.stringify(sanitized, null, 2)}`,
      },
    ],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'extract_process' },
  });

  // Extract annotations + parameters (with transient example values) from the
  // tool use response.
  const annotations: StepAnnotation[] = [];
  const captured: CapturedParam[] = [];

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'extract_process') {
      const input = block.input as { steps?: unknown[]; parameters?: unknown[] };
      if (Array.isArray(input.steps)) {
        for (const raw of input.steps) {
          const ann = asStepAnnotation(raw);
          if (ann) annotations.push(ann);
        }
      }
      if (Array.isArray(input.parameters)) {
        for (const raw of input.parameters) {
          const cp = asCapturedParam(raw);
          if (cp) captured.push(cp);
        }
      }
    }
  }

  // Build the deterministic step list, then run the capture-time guard against
  // the transient example values (the values are never persisted).
  const rawSteps = buildCanonicalSteps(canonicalCalls, annotations);
  const { steps, needsReview } = applyCaptureGuard(rawSteps, captured);

  const record: ProcessRecord = {
    id: randomUUID(),
    name,
    description: options.description ?? '',
    sourceRunId: runId,
    steps,
    parameters: captured.map(c => c.param), // persist the schema only — no example values
    createdAt: new Date().toISOString(),
  };
  if (needsReview) record.needsReview = true;
  return record;
}
